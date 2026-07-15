import { sessionGroupsDb } from '@/modules/database/index.js';
import type { SessionGroup } from '@/modules/database/index.js';
import { AppError } from '@/shared/utils.js';

function requireName(name: unknown): string {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed) {
    throw new AppError('Group name is required', { code: 'GROUP_NAME_REQUIRED', statusCode: 400 });
  }
  if (trimmed.length > 80) {
    throw new AppError('Group name too long', { code: 'GROUP_NAME_TOO_LONG', statusCode: 400 });
  }
  return trimmed;
}

function requireGroupId(rawId: unknown): number {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    throw new AppError('Invalid group id', { code: 'GROUP_ID_INVALID', statusCode: 400 });
  }
  return id;
}

function assertGroupExists(id: number): void {
  if (!sessionGroupsDb.groupExists(id)) {
    throw new AppError('Group not found', { code: 'GROUP_NOT_FOUND', statusCode: 404 });
  }
}

export function listSessionGroups(): { groups: SessionGroup[] } {
  return { groups: sessionGroupsDb.listGroupsWithMembers() };
}

export function createSessionGroup(name: unknown): SessionGroup {
  return sessionGroupsDb.createGroup(requireName(name));
}

export function renameSessionGroup(rawId: unknown, name: unknown): { id: number; name: string } {
  const id = requireGroupId(rawId);
  assertGroupExists(id);
  const trimmed = requireName(name);
  sessionGroupsDb.renameGroup(id, trimmed);
  return { id, name: trimmed };
}

export function deleteSessionGroup(rawId: unknown): { id: number } {
  const id = requireGroupId(rawId);
  sessionGroupsDb.deleteGroup(id);
  return { id };
}

export function reorderSessionGroups(ids: unknown): { orderedIds: number[] } {
  if (!Array.isArray(ids)) {
    throw new AppError('ids must be an array', { code: 'GROUP_ORDER_INVALID', statusCode: 400 });
  }
  const orderedIds = ids.map(requireGroupId);
  sessionGroupsDb.reorderGroups(orderedIds);
  return { orderedIds };
}

export function addSessionToGroup(
  rawId: unknown,
  body: { sessionId?: unknown; projectId?: unknown; provider?: unknown },
): { id: number; sessionId: string } {
  const id = requireGroupId(rawId);
  assertGroupExists(id);
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : '';
  if (!sessionId) {
    throw new AppError('sessionId is required', { code: 'SESSION_ID_REQUIRED', statusCode: 400 });
  }
  sessionGroupsDb.addMember(id, {
    sessionId,
    projectId: typeof body.projectId === 'string' ? body.projectId : null,
    provider: typeof body.provider === 'string' ? body.provider : null,
  });
  return { id, sessionId };
}

export function removeSessionFromGroup(rawId: unknown, rawSessionId: unknown): { id: number; sessionId: string } {
  const id = requireGroupId(rawId);
  const sessionId = typeof rawSessionId === 'string' ? rawSessionId.trim() : '';
  if (!sessionId) {
    throw new AppError('sessionId is required', { code: 'SESSION_ID_REQUIRED', statusCode: 400 });
  }
  sessionGroupsDb.removeMember(id, sessionId);
  return { id, sessionId };
}

export function reorderGroupMembers(rawId: unknown, sessionIds: unknown): { id: number; orderedSessionIds: string[] } {
  const id = requireGroupId(rawId);
  assertGroupExists(id);
  if (!Array.isArray(sessionIds) || !sessionIds.every((s) => typeof s === 'string')) {
    throw new AppError('sessionIds must be an array of strings', {
      code: 'MEMBER_ORDER_INVALID',
      statusCode: 400,
    });
  }
  sessionGroupsDb.reorderMembers(id, sessionIds as string[]);
  return { id, orderedSessionIds: sessionIds as string[] };
}
