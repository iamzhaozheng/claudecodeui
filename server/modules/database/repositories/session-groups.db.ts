import { getConnection } from '@/modules/database/connection.js';

export type SessionGroupMember = {
  sessionId: string;
  projectId: string | null;
  provider: string | null;
  position: number;
};

export type SessionGroup = {
  id: number;
  name: string;
  position: number;
  members: SessionGroupMember[];
};

type GroupRow = { id: number; name: string; position: number };
type MemberRow = {
  group_id: number;
  session_id: string;
  project_id: string | null;
  provider: string | null;
  position: number;
};

export const sessionGroupsDb = {
  /** All groups (ordered) with their member session refs (ordered). */
  listGroupsWithMembers(): SessionGroup[] {
    const db = getConnection();
    const groups = db
      .prepare('SELECT id, name, position FROM session_groups ORDER BY position ASC, id ASC')
      .all() as GroupRow[];
    const members = db
      .prepare(
        'SELECT group_id, session_id, project_id, provider, position FROM session_group_members ORDER BY position ASC, rowid ASC',
      )
      .all() as MemberRow[];

    const byGroup = new Map<number, SessionGroupMember[]>();
    for (const m of members) {
      const list = byGroup.get(m.group_id) ?? [];
      list.push({
        sessionId: m.session_id,
        projectId: m.project_id,
        provider: m.provider,
        position: m.position,
      });
      byGroup.set(m.group_id, list);
    }

    return groups.map((g) => ({
      id: g.id,
      name: g.name,
      position: g.position,
      members: byGroup.get(g.id) ?? [],
    }));
  },

  createGroup(name: string): SessionGroup {
    const db = getConnection();
    const nextPos =
      (db.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM session_groups').get() as { p: number }).p;
    const info = db
      .prepare('INSERT INTO session_groups (name, position) VALUES (?, ?)')
      .run(name, nextPos);
    return { id: Number(info.lastInsertRowid), name, position: nextPos, members: [] };
  },

  renameGroup(id: number, name: string): void {
    getConnection().prepare('UPDATE session_groups SET name = ? WHERE id = ?').run(name, id);
  },

  deleteGroup(id: number): void {
    // Members are removed by ON DELETE CASCADE.
    getConnection().prepare('DELETE FROM session_groups WHERE id = ?').run(id);
  },

  reorderGroups(orderedIds: number[]): void {
    const db = getConnection();
    const stmt = db.prepare('UPDATE session_groups SET position = ? WHERE id = ?');
    const tx = db.transaction((ids: number[]) => {
      ids.forEach((id, index) => stmt.run(index, id));
    });
    tx(orderedIds);
  },

  // Single-group semantics: a session lives in at most one group, so adding it
  // to a group first removes it from any other group.
  addMember(
    groupId: number,
    member: { sessionId: string; projectId?: string | null; provider?: string | null },
  ): void {
    const db = getConnection();
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM session_group_members WHERE session_id = ?').run(member.sessionId);
      const nextPos = (
        db
          .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM session_group_members WHERE group_id = ?')
          .get(groupId) as { p: number }
      ).p;
      db.prepare(
        `INSERT INTO session_group_members (group_id, session_id, project_id, provider, position)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(groupId, member.sessionId, member.projectId ?? null, member.provider ?? null, nextPos);
    });
    tx();
  },

  removeMember(groupId: number, sessionId: string): void {
    getConnection()
      .prepare('DELETE FROM session_group_members WHERE group_id = ? AND session_id = ?')
      .run(groupId, sessionId);
  },

  reorderMembers(groupId: number, orderedSessionIds: string[]): void {
    const db = getConnection();
    const stmt = db.prepare(
      'UPDATE session_group_members SET position = ? WHERE group_id = ? AND session_id = ?',
    );
    const tx = db.transaction((ids: string[]) => {
      ids.forEach((sessionId, index) => stmt.run(index, groupId, sessionId));
    });
    tx(orderedSessionIds);
  },

  groupExists(id: number): boolean {
    return Boolean(getConnection().prepare('SELECT 1 FROM session_groups WHERE id = ?').get(id));
  },
};
