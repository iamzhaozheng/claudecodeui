import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { ChevronDown, ChevronRight, FolderPlus, GripVertical, MoreHorizontal, Pencil, Plus, Trash2 } from 'lucide-react';

import type { LLMProvider, Project, ProjectSession } from '../../../../types/app';
import type { SessionWithProvider } from '../../types/types';
import type { SessionGroupsController, SessionGroupMemberRef } from '../../hooks/useSessionGroups';

import type { SidebarProjectListProps } from './SidebarProjectList';

type Props = {
  sessionGroups: SessionGroupsController;
  projectListProps: SidebarProjectListProps;
};

type SessionEntry = { session: SessionWithProvider; project: Project };
type DragPayload = { sessionId: string; projectId: string; provider: string };

function sessionTitle(session: ProjectSession): string {
  return (session.summary || session.title || session.name || '未命名会话') as string;
}

function sessionTime(session: ProjectSession): number {
  const raw = (session.lastActivity || session.updated_at || session.createdAt || session.created_at) as
    | string
    | undefined;
  const t = raw ? Date.parse(raw) : 0;
  return Number.isNaN(t) ? 0 : t;
}

/** One conversation row: draggable (grip hint + long-press), inline-renamable, with a ⋯ menu. */
function SessionRow({
  entry,
  selected,
  needsAttention,
  onOpen,
  editing,
  editValue,
  onEditChange,
  onEditCommit,
  onEditCancel,
  trailing,
}: {
  entry: SessionEntry;
  selected: boolean;
  needsAttention: boolean;
  onOpen: () => void;
  editing: boolean;
  editValue: string;
  onEditChange: (v: string) => void;
  onEditCommit: () => void;
  onEditCancel: () => void;
  trailing?: ReactNode;
}) {
  const payload: DragPayload = {
    sessionId: entry.session.id,
    projectId: entry.project.projectId,
    provider: (entry.session.__provider as string) || 'claude',
  };
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `sess:${entry.session.id}`,
    data: payload,
  });
  // Disable dragging while renaming so the text input stays usable.
  const dragProps = editing ? {} : { ...listeners, ...attributes };

  return (
    <div
      ref={setNodeRef}
      style={{ opacity: isDragging ? 0.4 : 1 }}
      className={`group/row flex cursor-pointer items-center gap-1 rounded-md px-1 py-1.5 text-sm ${
        selected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60'
      }`}
      onClick={editing ? undefined : onOpen}
      {...dragProps}
    >
      <GripVertical className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 group-hover/row:opacity-100" />
      {needsAttention && !selected && !editing && (
        <span
          role="status"
          aria-label="有新回复,待跟进"
          className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-amber-500"
        />
      )}
      {editing ? (
        <input
          autoFocus
          value={editValue}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => onEditChange(e.target.value)}
          onBlur={onEditCommit}
          onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
            if (e.key === 'Enter') onEditCommit();
            if (e.key === 'Escape') onEditCancel();
          }}
          className="flex-1 rounded border bg-background px-1 py-0.5 text-sm"
        />
      ) : (
        <span className="flex-1 truncate">{sessionTitle(entry.session)}</span>
      )}
      {trailing}
    </div>
  );
}

/** A group container that highlights and accepts dropped conversations. */
function GroupDroppable({ groupId, children }: { groupId: number; children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: `group:${groupId}` });
  return (
    <div ref={setNodeRef} className={`rounded-md ${isOver ? 'bg-primary/5 ring-2 ring-primary' : ''}`}>
      {children}
    </div>
  );
}

/** ⋯ popup: rename / delete / move-to-group / remove-from-group / new group. */
function SessionMoreMenu({
  groups,
  currentGroupId,
  onRename,
  onDelete,
  onSetGroup,
  onRemoveFromGroup,
  onCreateAndAdd,
  onClose,
}: {
  groups: Array<{ id: number; name: string }>;
  currentGroupId: number | null;
  onRename: () => void;
  onDelete: () => void;
  onSetGroup: (groupId: number) => void;
  onRemoveFromGroup: () => void;
  onCreateAndAdd: (name: string) => void | Promise<void>;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [name, setName] = useState('');

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="absolute right-2 top-8 z-50 w-52 rounded-md border bg-popover p-1 text-sm shadow-lg"
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-accent"
        onClick={() => {
          onClose();
          onRename();
        }}
      >
        <Pencil className="h-3.5 w-3.5" /> 改名
      </button>
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-destructive hover:bg-accent"
        onClick={() => {
          onClose();
          onDelete();
        }}
      >
        <Trash2 className="h-3.5 w-3.5" /> 删除对话
      </button>

      <div className="my-1 border-t" />
      <p className="px-2 py-0.5 text-xs text-muted-foreground">分组</p>
      {groups.map((g) => (
        <button
          key={g.id}
          type="button"
          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-accent"
          onClick={() => {
            onClose();
            if (g.id !== currentGroupId) onSetGroup(g.id);
          }}
        >
          <span className="w-3.5 text-center text-primary">{g.id === currentGroupId ? '●' : '○'}</span>
          <span className="truncate">{g.name}</span>
        </button>
      ))}
      {currentGroupId != null && (
        <button
          type="button"
          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-muted-foreground hover:bg-accent"
          onClick={() => {
            onClose();
            onRemoveFromGroup();
          }}
        >
          <span className="w-3.5 text-center">×</span> 移出分组
        </button>
      )}
      <div className="mt-1 flex items-center gap-1 border-t px-1 pt-1">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && name.trim()) {
              void onCreateAndAdd(name.trim());
              setName('');
              onClose();
            }
          }}
          placeholder="新建组并移入…"
          className="flex-1 rounded border bg-background px-2 py-1 text-xs"
        />
      </div>
    </div>
  );
}

/** ⋯ popup for a group header: new session / rename / delete. */
function GroupMoreMenu({
  onNewSession,
  onRename,
  onDelete,
  onClose,
}: {
  onNewSession: () => void;
  onRename: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);
  return (
    <div
      ref={ref}
      className="absolute right-1 top-8 z-50 w-44 rounded-md border bg-popover p-1 text-sm shadow-lg"
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-accent"
        onClick={() => {
          onClose();
          onNewSession();
        }}
      >
        <Plus className="h-3.5 w-3.5" /> 新建 session
      </button>
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-accent"
        onClick={() => {
          onClose();
          onRename();
        }}
      >
        <Pencil className="h-3.5 w-3.5" /> 改名
      </button>
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-destructive hover:bg-accent"
        onClick={() => {
          onClose();
          onDelete();
        }}
      >
        <Trash2 className="h-3.5 w-3.5" /> 删除分组
      </button>
    </div>
  );
}

export default function SidebarGroupsView({ sessionGroups, projectListProps }: Props) {
  const {
    projects,
    selectedSession,
    onSessionSelect,
    editingSession,
    editingSessionName,
    onEditingSessionNameChange,
    onStartEditingSession,
    onCancelEditingSession,
    onSaveEditingSession,
    onDeleteSession,
    attentionSessionIds,
  } = projectListProps;
  const {
    groups,
    createGroup,
    renameGroup,
    deleteGroup,
    addSessionToGroup,
    removeSessionFromGroup,
    createSessionInGroup,
    refreshGroups,
  } = sessionGroups;

  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [moreMenuFor, setMoreMenuFor] = useState<string | null>(null);
  const [groupMenuFor, setGroupMenuFor] = useState<number | null>(null);
  const [dragTitle, setDragTitle] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
  );

  const { flatSessions, byId } = useMemo(() => {
    const map = new Map<string, SessionEntry>();
    const flat: SessionEntry[] = [];
    for (const project of projects) {
      for (const session of project.sessions ?? []) {
        const withProvider = {
          ...session,
          __provider: (session.provider as SessionWithProvider['__provider']) || 'claude',
        } as SessionWithProvider;
        if (!map.has(session.id)) {
          const entry = { session: withProvider, project };
          map.set(session.id, entry);
          flat.push(entry);
        }
      }
    }
    flat.sort((a, b) => sessionTime(b.session) - sessionTime(a.session));
    return { flatSessions: flat, byId: map };
  }, [projects]);

  // Resolve a group member to a renderable entry. Prefer the fully-loaded
  // session from the main list; otherwise synthesize a minimal entry from the
  // server-provided member data (name/projectId/provider) so grouped sessions
  // show even when the paginated main list hasn't loaded them (e.g. after a
  // Codex import floods the recent list and pushes older grouped sessions off
  // the first page). Clicking still navigates by id and hydrates the rest.
  const memberToEntry = (m: SessionGroupMemberRef): SessionEntry => {
    const existing = byId.get(m.sessionId);
    if (existing) {
      return existing;
    }
    return {
      session: {
        id: m.sessionId,
        summary: m.name ?? '',
        __provider: (m.provider as SessionWithProvider['__provider']) || 'claude',
      } as SessionWithProvider,
      project: { projectId: m.projectId ?? '' } as Project,
    };
  };

  // Group members carry a server-side `exists` flag, but the cached group list
  // goes stale when a session is archived/deleted. Re-fetch groups whenever the
  // set of loaded sessions changes so archived/removed members drop out.
  const sessionIdSignature = useMemo(
    () => projects.flatMap((p) => (p.sessions ?? []).map((s) => s.id)).sort().join(','),
    [projects],
  );
  useEffect(() => {
    void refreshGroups();
  }, [sessionIdSignature, refreshGroups]);

  const groupedIds = new Set(groups.flatMap((g) => g.members.map((m) => m.sessionId)));
  const ungroupedSessions = flatSessions.filter((entry) => !groupedIds.has(entry.session.id));

  const toggleExpanded = (id: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const submitCreate = async () => {
    const name = newName.trim();
    setNewName('');
    setCreating(false);
    if (name) await createGroup(name);
  };

  // Start a brand-new conversation and drop it into this group, then open it.
  const newSessionInGroup = async (groupId: number) => {
    setGroupMenuFor(null);
    const group = groups.find((g) => g.id === groupId);
    const memberProject = group?.members.map((m) => byId.get(m.sessionId)?.project).find(Boolean);
    const selectedProject = projects.find((p) => (p.sessions ?? []).some((s) => s.id === selectedSession?.id));
    const project = memberProject || selectedProject || projects[0];
    if (!project) return;
    const projectPath = (project.fullPath || project.path || '') as string;
    const sessionId = await createSessionInGroup(groupId, {
      projectPath,
      projectId: project.projectId,
      provider: 'claude',
    });
    setExpanded((prev) => new Set(prev).add(groupId));
    if (sessionId) {
      onSessionSelect({ id: sessionId, __provider: 'claude' } as SessionWithProvider, project.projectId);
    }
  };

  const handleDragStart = (event: DragStartEvent) => {
    const data = event.active.data.current as DragPayload | undefined;
    const entry = data ? byId.get(data.sessionId) : undefined;
    setDragTitle(entry ? sessionTitle(entry.session) : null);
  };

  const handleDragEnd = (event: DragEndEvent) => {
    setDragTitle(null);
    const { active, over } = event;
    if (!over) return;
    const overId = String(over.id);
    if (!overId.startsWith('group:')) return;
    const groupId = Number(overId.slice('group:'.length));
    const data = active.data.current as DragPayload | undefined;
    if (!data) return;
    void addSessionToGroup(groupId, data);
    setExpanded((prev) => new Set(prev).add(groupId));
  };

  // Renders a conversation row with its ⋯ menu. `currentGroupId` is the group it
  // is shown under (null = the ungrouped list).
  const renderRow = (entry: SessionEntry, currentGroupId: number | null) => {
    const sessionId = entry.session.id;
    const provider = (entry.session.__provider as LLMProvider) || 'claude';
    return (
      <div key={sessionId} className="relative">
        <SessionRow
          entry={entry}
          selected={selectedSession?.id === sessionId}
          needsAttention={attentionSessionIds.has(sessionId)}
          onOpen={() => onSessionSelect(entry.session, entry.project.projectId)}
          editing={editingSession === sessionId}
          editValue={editingSessionName}
          onEditChange={onEditingSessionNameChange}
          onEditCommit={() => {
            onSaveEditingSession(entry.project.projectId, sessionId, editingSessionName, provider);
          }}
          onEditCancel={onCancelEditingSession}
          trailing={
            <button
              type="button"
              className="rounded p-1 text-muted-foreground opacity-0 hover:bg-accent group-hover/row:opacity-100"
              title="更多"
              onClick={(e) => {
                e.stopPropagation();
                setMoreMenuFor(moreMenuFor === sessionId ? null : sessionId);
              }}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          }
        />
        {moreMenuFor === sessionId && (
          <SessionMoreMenu
            groups={groups.map((g) => ({ id: g.id, name: g.name }))}
            currentGroupId={currentGroupId}
            onRename={() => onStartEditingSession(sessionId, sessionTitle(entry.session))}
            onDelete={() => onDeleteSession(entry.project.projectId, sessionId, sessionTitle(entry.session), provider)}
            onSetGroup={(groupId) =>
              void addSessionToGroup(groupId, {
                sessionId,
                projectId: entry.project.projectId,
                provider,
              })
            }
            onRemoveFromGroup={() => {
              if (currentGroupId != null) void removeSessionFromGroup(currentGroupId, sessionId);
            }}
            onCreateAndAdd={async (name) => {
              const id = await createGroup(name);
              if (id != null)
                await addSessionToGroup(id, { sessionId, projectId: entry.project.projectId, provider });
            }}
            onClose={() => setMoreMenuFor(null)}
          />
        )}
      </div>
    );
  };

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div className="space-y-4 px-2 py-2">
        {/* ── Custom groups ─────────────────────────────────────────── */}
        <div>
          <div className="mb-1 flex items-center justify-between px-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">自定义分组</span>
            <button
              type="button"
              className="rounded p-1 text-muted-foreground hover:bg-accent"
              title="新建分组"
              onClick={() => {
                setCreating(true);
                setNewName('');
              }}
            >
              <FolderPlus className="h-4 w-4" />
            </button>
          </div>

          {creating && (
            <div className="mb-1 flex items-center gap-1 px-1">
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submitCreate();
                  if (e.key === 'Escape') {
                    setCreating(false);
                    setNewName('');
                  }
                }}
                placeholder="分组名称"
                className="flex-1 rounded border bg-background px-2 py-1 text-sm"
              />
              <button type="button" className="rounded p-1 hover:bg-accent" onClick={() => void submitCreate()}>
                <Plus className="h-4 w-4" />
              </button>
            </div>
          )}

          {groups.length === 0 && !creating && (
            <p className="px-2 py-1 text-xs text-muted-foreground">
              还没有分组。点右上 + 新建,然后把下面的对话拖进来(或用对话的 ⋯ 菜单)。
            </p>
          )}

          {groups.map((group) => {
            const isOpen = expanded.has(group.id);
            // Hide members whose session is archived/deleted/not-loaded so no
            // broken "会话 xxxx" placeholder appears; the membership stays in the
            // DB so a restored session returns to its group.
            // Show a member if the server says its session still exists, or if
            // it's already in the loaded list (covers optimistic just-added rows
            // before the next groups refresh). Only true orphans are hidden.
            // Hide members the server says are gone (archived/deleted →
            // exists:false), even if a stale copy is still in the loaded list.
            // `byId` is only a fallback for optimistic just-added rows whose
            // exists flag hasn't been reported by the server yet.
            const visibleMembers = group.members.filter(
              (m) => m.exists !== false && (m.exists === true || byId.has(m.sessionId)),
            );
            // When a group is collapsed, surface a dot on its header if any
            // conversation inside it has a new reply to follow up on.
            const groupHasAttention = visibleMembers.some((m) => attentionSessionIds.has(m.sessionId));
            return (
              <GroupDroppable key={group.id} groupId={group.id}>
                <div className="mb-0.5">
                  <div className="group/gh relative flex items-center gap-1 rounded-md px-1 py-1 hover:bg-accent/60">
                    <button type="button" className="p-0.5" onClick={() => toggleExpanded(group.id)}>
                      {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                    </button>
                    {renamingId === group.id ? (
                      <input
                        autoFocus
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onBlur={() => {
                          void renameGroup(group.id, renameValue);
                          setRenamingId(null);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            void renameGroup(group.id, renameValue);
                            setRenamingId(null);
                          }
                          if (e.key === 'Escape') setRenamingId(null);
                        }}
                        className="flex-1 rounded border bg-background px-1 py-0.5 text-sm"
                      />
                    ) : (
                      <button
                        type="button"
                        className="flex flex-1 items-center gap-1 truncate text-left text-sm font-medium"
                        onClick={() => toggleExpanded(group.id)}
                      >
                        <span className="truncate">{group.name}</span>
                        <span className="text-xs text-muted-foreground">({visibleMembers.length})</span>
                        {!isOpen && groupHasAttention && (
                          <span
                            role="status"
                            aria-label="组内有新回复"
                            className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-amber-500"
                          />
                        )}
                      </button>
                    )}
                    <button
                      type="button"
                      className="rounded p-1 text-muted-foreground opacity-0 hover:bg-accent group-hover/gh:opacity-100"
                      title="更多"
                      onClick={() => setGroupMenuFor(groupMenuFor === group.id ? null : group.id)}
                    >
                      <MoreHorizontal className="h-3.5 w-3.5" />
                    </button>
                    {groupMenuFor === group.id && (
                      <GroupMoreMenu
                        onNewSession={() => void newSessionInGroup(group.id)}
                        onRename={() => {
                          setRenamingId(group.id);
                          setRenameValue(group.name);
                        }}
                        onDelete={() => {
                          if (window.confirm(`删除分组「${group.name}」?(不会删除会话本身)`)) void deleteGroup(group.id);
                        }}
                        onClose={() => setGroupMenuFor(null)}
                      />
                    )}
                  </div>

                  {isOpen && (
                    <div className="pl-5 pr-1">
                      {visibleMembers.length === 0 && (
                        <p className="px-2 py-1 text-xs text-muted-foreground">空分组。把下面的对话拖进来。</p>
                      )}
                      {visibleMembers.map((member) => renderRow(memberToEntry(member), group.id))}
                    </div>
                  )}
                </div>
              </GroupDroppable>
            );
          })}
        </div>

        {/* ── Ungrouped conversations ───────────────────────────────── */}
        <div>
          <div className="mb-1 px-1">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">未分组对话</span>
          </div>
          {ungroupedSessions.length === 0 && (
            <p className="px-2 py-1 text-xs text-muted-foreground">所有对话都已归组。</p>
          )}
          {ungroupedSessions.map((entry) => renderRow(entry, null))}
        </div>
      </div>

      <DragOverlay>
        {dragTitle ? (
          <div className="max-w-[220px] truncate rounded-md border bg-popover px-2 py-1.5 text-sm shadow-lg">
            {dragTitle}
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}
