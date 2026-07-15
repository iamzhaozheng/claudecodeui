import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, FolderPlus, Pencil, Plus, Trash2, X } from 'lucide-react';

import type { Project, ProjectSession } from '../../../../types/app';
import type { SessionWithProvider } from '../../types/types';
import type { SessionGroupsController } from '../../hooks/useSessionGroups';

import type { SidebarProjectListProps } from './SidebarProjectList';

type Props = {
  sessionGroups: SessionGroupsController;
  projectListProps: SidebarProjectListProps;
};

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

export default function SidebarGroupsView({ sessionGroups, projectListProps }: Props) {
  const { projects, selectedSession, onSessionSelect } = projectListProps;
  const {
    groups,
    createGroup,
    renameGroup,
    deleteGroup,
    addSessionToGroup,
    removeSessionFromGroup,
  } = sessionGroups;

  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [addMenuFor, setAddMenuFor] = useState<string | null>(null); // sessionId whose add-menu is open

  // sessionId -> {session, project} for fast lookup + the flat list.
  const { flatSessions, byId } = useMemo(() => {
    const map = new Map<string, { session: SessionWithProvider; project: Project }>();
    const flat: Array<{ session: SessionWithProvider; project: Project }> = [];
    for (const project of projects) {
      for (const session of project.sessions ?? []) {
        const withProvider = {
          ...session,
          __provider: (session.provider as SessionWithProvider['__provider']) || 'claude',
        } as SessionWithProvider;
        const entry = { session: withProvider, project };
        if (!map.has(session.id)) {
          map.set(session.id, entry);
          flat.push(entry);
        }
      }
    }
    flat.sort((a, b) => sessionTime(b.session) - sessionTime(a.session));
    return { flatSessions: flat, byId: map };
  }, [projects]);

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

  const membershipFor = (sessionId: string) =>
    new Set(groups.filter((g) => g.members.some((m) => m.sessionId === sessionId)).map((g) => g.id));

  const openSession = (session: SessionWithProvider, projectId: string) => {
    onSessionSelect(session, projectId);
  };

  const Row = ({
    session,
    project,
    trailing,
  }: {
    session: SessionWithProvider;
    project: Project;
    trailing?: React.ReactNode;
  }) => {
    const isSelected = selectedSession?.id === session.id;
    return (
      <div
        className={`group/row flex cursor-pointer items-center gap-1 rounded-md px-2 py-1.5 text-sm ${
          isSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60'
        }`}
        onClick={() => openSession(session, project.projectId)}
      >
        <span className="flex-1 truncate">{sessionTitle(session)}</span>
        {trailing}
      </div>
    );
  };

  return (
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
          <p className="px-2 py-1 text-xs text-muted-foreground">还没有分组。点右上 + 新建,或在下面对话上点「加入组」。</p>
        )}

        {groups.map((group) => {
          const isOpen = expanded.has(group.id);
          return (
            <div key={group.id} className="mb-0.5">
              <div className="group/gh flex items-center gap-1 rounded-md px-1 py-1 hover:bg-accent/60">
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
                    <span className="text-xs text-muted-foreground">({group.members.length})</span>
                  </button>
                )}
                <button
                  type="button"
                  className="rounded p-1 text-muted-foreground opacity-0 hover:bg-accent group-hover/gh:opacity-100"
                  title="重命名"
                  onClick={() => {
                    setRenamingId(group.id);
                    setRenameValue(group.name);
                  }}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  className="rounded p-1 text-muted-foreground opacity-0 hover:bg-accent group-hover/gh:opacity-100"
                  title="删除分组"
                  onClick={() => {
                    if (window.confirm(`删除分组「${group.name}」?(不会删除会话本身)`)) void deleteGroup(group.id);
                  }}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>

              {isOpen && (
                <div className="pl-5 pr-1">
                  {group.members.length === 0 && (
                    <p className="px-2 py-1 text-xs text-muted-foreground">空分组。从下面把对话拖/点进来。</p>
                  )}
                  {group.members.map((member) => {
                    const entry = byId.get(member.sessionId);
                    if (!entry) {
                      return (
                        <div key={member.sessionId} className="flex items-center gap-1 rounded-md px-2 py-1.5 text-sm">
                          <span className="flex-1 truncate text-muted-foreground">会话 {member.sessionId.slice(0, 8)}</span>
                          <button
                            type="button"
                            className="rounded p-1 hover:bg-accent"
                            title="移出分组"
                            onClick={() => void removeSessionFromGroup(group.id, member.sessionId)}
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      );
                    }
                    return (
                      <Row
                        key={member.sessionId}
                        session={entry.session}
                        project={entry.project}
                        trailing={
                          <button
                            type="button"
                            className="rounded p-1 text-muted-foreground opacity-0 hover:bg-accent group-hover/row:opacity-100"
                            title="移出分组"
                            onClick={(e) => {
                              e.stopPropagation();
                              void removeSessionFromGroup(group.id, member.sessionId);
                            }}
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        }
                      />
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ── All conversations (flat) ──────────────────────────────── */}
      <div>
        <div className="mb-1 px-1">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">全部对话</span>
        </div>
        {flatSessions.map(({ session, project }) => {
          const memberIds = membershipFor(session.id);
          return (
            <div key={session.id} className="relative">
              <Row
                session={session}
                project={project}
                trailing={
                  <button
                    type="button"
                    className={`rounded p-1 text-muted-foreground hover:bg-accent ${
                      memberIds.size > 0 ? 'text-primary opacity-100' : 'opacity-0 group-hover/row:opacity-100'
                    }`}
                    title="加入分组"
                    onClick={(e) => {
                      e.stopPropagation();
                      setAddMenuFor(addMenuFor === session.id ? null : session.id);
                    }}
                  >
                    <FolderPlus className="h-3.5 w-3.5" />
                  </button>
                }
              />
              {addMenuFor === session.id && (
                <AddToGroupMenu
                  groups={groups.map((g) => ({ id: g.id, name: g.name, member: memberIds.has(g.id) }))}
                  onToggle={(groupId, isMember) => {
                    if (isMember) void removeSessionFromGroup(groupId, session.id);
                    else
                      void addSessionToGroup(groupId, {
                        sessionId: session.id,
                        projectId: project.projectId,
                        provider: session.__provider,
                      });
                  }}
                  onCreateAndAdd={async (name) => {
                    const id = await createGroup(name);
                    if (id != null)
                      await addSessionToGroup(id, {
                        sessionId: session.id,
                        projectId: project.projectId,
                        provider: session.__provider,
                      });
                  }}
                  onClose={() => setAddMenuFor(null)}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AddToGroupMenu({
  groups,
  onToggle,
  onCreateAndAdd,
  onClose,
}: {
  groups: Array<{ id: number; name: string; member: boolean }>;
  onToggle: (groupId: number, isMember: boolean) => void;
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
      {groups.length === 0 && <p className="px-2 py-1 text-xs text-muted-foreground">还没有分组</p>}
      {groups.map((g) => (
        <button
          key={g.id}
          type="button"
          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-accent"
          onClick={() => onToggle(g.id, g.member)}
        >
          <span
            className={`flex h-4 w-4 items-center justify-center rounded border text-xs ${
              g.member ? 'border-primary bg-primary text-primary-foreground' : ''
            }`}
          >
            {g.member ? '✓' : ''}
          </span>
          <span className="truncate">{g.name}</span>
        </button>
      ))}
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
          placeholder="新建组并加入…"
          className="flex-1 rounded border bg-background px-2 py-1 text-xs"
        />
      </div>
    </div>
  );
}
