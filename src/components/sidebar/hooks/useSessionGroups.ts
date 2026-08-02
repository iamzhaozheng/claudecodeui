import { useCallback, useEffect, useState } from 'react';

import { api } from '../../../utils/api';

export interface SessionGroupMemberRef {
  sessionId: string;
  projectId: string | null;
  provider: string | null;
  position: number;
  /** Display name resolved server-side; null for orphan (deleted) sessions. */
  name?: string | null;
  /** Whether the session still exists (not deleted/archived) server-side. */
  exists?: boolean;
}

export interface SessionGroupData {
  id: number;
  name: string;
  position: number;
  members: SessionGroupMemberRef[];
}

async function readData<T>(res: Response): Promise<T | null> {
  try {
    if (!res.ok) return null;
    const body = await res.json();
    return (body?.data ?? body) as T;
  } catch {
    return null;
  }
}

/**
 * Owns the user's custom session groups (server-persisted, cross-device).
 * Mutations update local state optimistically and resync from the server on
 * failure, mirroring the star-toggle pattern elsewhere in the sidebar.
 */
export function useSessionGroups() {
  const [groups, setGroups] = useState<SessionGroupData[]>([]);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    const data = await readData<{ groups: SessionGroupData[] }>(await api.listSessionGroups());
    if (data?.groups) {
      setGroups(data.groups);
    }
    setLoaded(true);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const createGroup = useCallback(async (name: string): Promise<number | null> => {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const created = await readData<SessionGroupData>(await api.createSessionGroup(trimmed));
    if (created?.id != null) {
      setGroups((prev) => [...prev, { ...created, members: created.members ?? [] }]);
      return created.id;
    }
    void refresh();
    return null;
  }, [refresh]);

  const renameGroup = useCallback(async (id: number, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setGroups((prev) => prev.map((g) => (g.id === id ? { ...g, name: trimmed } : g)));
    const res = await api.renameSessionGroup(id, trimmed);
    if (!res.ok) void refresh();
  }, [refresh]);

  const deleteGroup = useCallback(async (id: number) => {
    setGroups((prev) => prev.filter((g) => g.id !== id));
    const res = await api.deleteSessionGroup(id);
    if (!res.ok) void refresh();
  }, [refresh]);

  const addSessionToGroup = useCallback(
    async (groupId: number, member: { sessionId: string; projectId?: string | null; provider?: string | null }) => {
      // Single-group: drop the session from every group, then add it to the target.
      setGroups((prev) =>
        prev.map((g) => {
          const cleaned = g.members.filter((m) => m.sessionId !== member.sessionId);
          if (g.id !== groupId) {
            return cleaned.length === g.members.length ? g : { ...g, members: cleaned };
          }
          return {
            ...g,
            members: [
              ...cleaned,
              {
                sessionId: member.sessionId,
                projectId: member.projectId ?? null,
                provider: member.provider ?? null,
                position: cleaned.length,
              },
            ],
          };
        }),
      );
      const res = await api.addSessionToGroup(groupId, member);
      if (!res.ok) void refresh();
    },
    [refresh],
  );

  const removeSessionFromGroup = useCallback(async (groupId: number, sessionId: string) => {
    setGroups((prev) =>
      prev.map((g) => (g.id === groupId ? { ...g, members: g.members.filter((m) => m.sessionId !== sessionId) } : g)),
    );
    const res = await api.removeSessionFromGroup(groupId, sessionId);
    if (!res.ok) void refresh();
  }, [refresh]);

  // Allocate a brand-new provider session, then drop it into the group.
  const createSessionInGroup = useCallback(
    async (
      groupId: number,
      opts: { projectPath: string; projectId: string; provider?: string },
    ): Promise<string | null> => {
      const provider = opts.provider || 'claude';
      let sessionId: string | null = null;
      try {
        const res = await api.createProviderSession(provider, opts.projectPath);
        if (res.ok) {
          const body = await res.json();
          sessionId = (body?.data?.sessionId ?? body?.sessionId ?? null) as string | null;
        }
      } catch {
        sessionId = null;
      }
      if (sessionId) {
        await addSessionToGroup(groupId, { sessionId, projectId: opts.projectId, provider });
      }
      return sessionId;
    },
    [addSessionToGroup],
  );

  const reorderGroups = useCallback(async (orderedIds: number[]) => {
    setGroups((prev) => {
      const byId = new Map(prev.map((g) => [g.id, g]));
      return orderedIds.map((id) => byId.get(id)).filter((g): g is SessionGroupData => Boolean(g));
    });
    const res = await api.reorderSessionGroups(orderedIds);
    if (!res.ok) void refresh();
  }, [refresh]);

  const reorderGroupMembers = useCallback(async (groupId: number, orderedSessionIds: string[]) => {
    setGroups((prev) =>
      prev.map((g) => {
        if (g.id !== groupId) return g;
        const byId = new Map(g.members.map((m) => [m.sessionId, m]));
        const members = orderedSessionIds
          .map((sid) => byId.get(sid))
          .filter((m): m is SessionGroupMemberRef => Boolean(m));
        return { ...g, members };
      }),
    );
    const res = await api.reorderGroupMembers(groupId, orderedSessionIds);
    if (!res.ok) void refresh();
  }, [refresh]);

  return {
    groups,
    groupsLoaded: loaded,
    refreshGroups: refresh,
    createGroup,
    renameGroup,
    deleteGroup,
    addSessionToGroup,
    removeSessionFromGroup,
    createSessionInGroup,
    reorderGroups,
    reorderGroupMembers,
  };
}

export type SessionGroupsController = ReturnType<typeof useSessionGroups>;
