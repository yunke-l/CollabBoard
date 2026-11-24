import { MemberSelect } from '../../features/projects/member-select';
import { useRef, useState, type FormEvent } from 'react';
import { useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  limits,
  projectCapabilities,
  updateProjectSchema,
  type MemberSnapshot,
  type Project,
} from '@collabboard/contracts';
import { useSession } from '../../app/providers/session';
import { api, ApiError } from '../../shared/api/client';
import {
  Dialog,
  ErrorState,
  LoadingState,
  Notice,
} from '../../shared/ui/common';
import { useOnline } from '../../shared/lib/use-online';
import {
  refreshProject,
  useProjectAccess,
} from '../../features/projects/use-project-access';
import { LeaveProject } from '../../features/projects/leave-project';

export function SettingsPage() {
  const { projectId = '' } = useParams();
  const { user } = useSession();
  const query = useQuery({
    queryKey: ['project', projectId, user?.id],
    queryFn: ({ signal }) => api<Project>(`/projects/${projectId}`, { signal }),
    refetchInterval: 30000,
    refetchOnMount: 'always',
  });
  const members = useQuery({
    queryKey: ['members', projectId, user?.id],
    queryFn: ({ signal }) =>
      api<MemberSnapshot>(`/projects/${projectId}/members`, { signal }),
    enabled: query.data?.role === 'Owner',
    refetchInterval: 30000,
    refetchOnMount: 'always',
  });
  useProjectAccess(projectId, query.error ?? members.error);
  if (query.isPending)
    return (
      <div>
        <LoadingState />
      </div>
    );
  if (query.isError)
    return (
      <div>
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      </div>
    );
  return (
    <ProjectSettings
      key={projectId}
      project={query.data}
      members={members.data?.members}
      memberError={members.error}
      retryMembers={() => void members.refetch()}
    />
  );
}

type Confirmation = {
  kind: 'archive' | 'restore' | 'ownership';
  expectedBoardRevision: number;
  memberId?: string;
  memberName?: string;
  requestId: string;
};
function ProjectSettings({
  project,
  members,
  memberError,
  retryMembers,
}: {
  project: Project;
  members: MemberSnapshot['members'] | undefined;
  memberError: Error | null;
  retryMembers: () => void;
}) {
  const online = useOnline();
  const client = useQueryClient();
  const [draft, setDraft] = useState({
    name: project.name,
    description: project.description,
    expectedBoardRevision: project.boardRevision,
  });
  const eligibleMembers = members
    ?.filter((member) => member.role !== 'Owner')
    .map((member) => ({
      value: member.id,
      label: `${member.displayName} (${member.role})`,
    }));
  const [targetId, setTargetId] = useState('');
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [conflict, setConflict] = useState(false);
  const attempt = useRef<{ content: string; requestId: string } | null>(null);
  const capability = projectCapabilities(
    project.role,
    project.status,
    false,
    online,
  );
  const changed = draft.expectedBoardRevision !== project.boardRevision;
  async function save(event: FormEvent) {
    event.preventDefault();
    if (pending || !capability.canManageProject || conflict) return;
    setError('');
    setSaved(false);
    const content = JSON.stringify(draft);
    if (attempt.current?.content !== content)
      attempt.current = { content, requestId: crypto.randomUUID() };
    const input = updateProjectSchema.safeParse({
      ...draft,
      requestId: attempt.current.requestId,
    });
    if (!input.success) {
      setError(input.error.issues[0]!.message);
      return;
    }
    setPending(true);
    try {
      const result = await api<Project>(`/projects/${project.id}`, {
        method: 'PATCH',
        body: input.data,
      });
      setDraft({
        name: result.name,
        description: result.description,
        expectedBoardRevision: result.boardRevision,
      });
      setSaved(true);
      setConflict(false);
      await refreshProject(client, project.id);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Unable to save the project. Your draft is kept.',
      );
      if (
        failure instanceof ApiError &&
        failure.detail.code === 'VERSION_CONFLICT'
      )
        setConflict(true);
      await refreshProject(client, project.id);
    } finally {
      setPending(false);
    }
  }
  async function confirm() {
    if (
      !confirmation ||
      pending ||
      !online ||
      confirmation.expectedBoardRevision !== project.boardRevision
    )
      return;
    setPending(true);
    setError('');
    const { kind, memberName: _memberName, ...body } = confirmation;
    try {
      await api<Project>(`/projects/${project.id}/${kind}`, {
        method: 'POST',
        body,
      });
      setConfirmation(null);
      await refreshProject(client, project.id);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Unable to save this change.',
      );
      await refreshProject(client, project.id);
    } finally {
      setPending(false);
    }
  }
  function open(kind: Confirmation['kind']) {
    setError('');
    setConfirmation({
      kind,
      expectedBoardRevision: project.boardRevision,
      requestId: crypto.randomUUID(),
      ...(kind === 'ownership'
        ? {
            memberId: targetId,
            memberName:
              members?.find((member) => member.id === targetId)?.displayName ??
              'the selected member',
          }
        : {}),
    });
  }
  return (
    <div className="settings-content">
      <div className="page-heading">
        <div>
          <h2>Project settings</h2>
        </div>
      </div>
      {!online && (
        <Notice>
          You are offline. Your draft is kept. Changes are paused until your
          connection returns.
        </Notice>
      )}
      {project.role !== 'Owner' ? (
        <Notice>
          Project settings are managed by the current Owner. Your role is{' '}
          {project.role}.
        </Notice>
      ) : (
        <>
          {project.status === 'archived' && (
            <Notice>
              This project is archived. Restore it to edit details or transfer
              ownership.
            </Notice>
          )}
          <section className="settings-section">
            <h2>Project details</h2>
            <form onSubmit={(event) => void save(event)}>
              <label className="field">
                Project name
                <input
                  required
                  maxLength={limits.projectName}
                  value={draft.name}
                  readOnly={!capability.canManageProject || pending}
                  onChange={(event) => {
                    setDraft({ ...draft, name: event.target.value });
                    setSaved(false);
                  }}
                />
              </label>
              <label className="field">
                Description
                <textarea
                  aria-label="Project description"
                  rows={4}
                  maxLength={limits.projectDescription}
                  value={draft.description}
                  readOnly={!capability.canManageProject || pending}
                  onChange={(event) => {
                    setDraft({ ...draft, description: event.target.value });
                    setSaved(false);
                  }}
                />
              </label>
              {(changed || conflict) && (
                <div className="action-confirmation">
                  <p>
                    The project changed since this draft began. Latest saved
                    details: <strong>{project.name}</strong> —{' '}
                    {project.description || 'No description'}.
                  </p>
                  <button
                    type="button"
                    className="button"
                    disabled={
                      pending || !capability.canManageProject || !changed
                    }
                    onClick={() => {
                      setDraft({
                        ...draft,
                        expectedBoardRevision: project.boardRevision,
                      });
                      setConflict(false);
                      setError('');
                    }}
                  >
                    Use latest project version
                  </button>
                  <p>Your draft text will be kept.</p>
                </div>
              )}
              {!confirmation && error && (
                <p className="error-copy" role="alert">
                  {error}
                </p>
              )}
              {saved && <p role="status">Project details saved.</p>}
              <button
                className="button primary"
                disabled={pending || !capability.canManageProject || conflict}
              >
                Save project details
              </button>
            </form>
          </section>
          <section className="settings-section">
            <h2>
              {project.status === 'archived'
                ? 'Restore project'
                : 'Archive project'}
            </h2>
            <p>
              {project.status === 'archived'
                ? 'Return the project to active work. Your active project quota will be checked.'
                : 'Pause work and keep tasks, members, and history. Archived projects count toward your total project quota.'}
            </p>
            <button
              className="button"
              disabled={
                pending ||
                !(capability.canManageProject || capability.canRestoreProject)
              }
              onClick={() =>
                open(project.status === 'archived' ? 'restore' : 'archive')
              }
            >
              {project.status === 'archived'
                ? 'Restore project'
                : 'Archive project'}
            </button>
          </section>
          <section className="settings-section">
            <h2>Transfer ownership</h2>
            <p>
              The new Owner takes over project settings and quotas. You will
              become an Editor.
            </p>
            {memberError && (
              <Notice>
                Members could not be refreshed.{' '}
                <button className="button" onClick={retryMembers}>
                  Retry members
                </button>
              </Notice>
            )}
            <label className="field">
              New Owner
              <MemberSelect
                aria-label="New Owner"
                value={
                  eligibleMembers?.some((member) => member.value === targetId)
                    ? targetId
                    : ''
                }
                options={eligibleMembers}
                placeholder="Choose a member"
                emptyLabel="No eligible members"
                loadFailed={!!memberError}
                disabled={
                  pending || !capability.canManageProject || !!memberError
                }
                onChange={(event) => setTargetId(event.target.value)}
              />
            </label>
            <button
              className="button"
              disabled={
                pending ||
                !capability.canManageProject ||
                !targetId ||
                !!memberError ||
                !members?.some(
                  (member) => member.id === targetId && member.role !== 'Owner',
                )
              }
              onClick={() => open('ownership')}
            >
              Transfer ownership
            </button>
          </section>
        </>
      )}
      <section className="settings-section">
        <h2>Leave project</h2>
        <p>Owners must transfer ownership before leaving.</p>
        <LeaveProject project={project} />
      </section>
      {confirmation && (
        <Dialog
          busy={pending}
          title={
            confirmation.kind === 'ownership'
              ? 'Transfer ownership'
              : confirmation.kind === 'archive'
                ? 'Archive project'
                : 'Restore project'
          }
          onClose={() => {
            if (!pending) setConfirmation(null);
          }}
        >
          <p>
            {confirmation.kind === 'ownership'
              ? `Transfer ${project.name} to ${confirmation.memberName}? You will become an Editor and lose access to Owner settings.`
              : confirmation.kind === 'archive'
                ? `Archive ${project.name}? All content changes will pause until the Owner restores it.`
                : `Restore ${project.name}? Your active project quota will be checked.`}
          </p>
          {error && (
            <p className="error-copy" role="alert">
              {error}
            </p>
          )}
          {confirmation.expectedBoardRevision !== project.boardRevision && (
            <Notice>
              This project changed. Close this confirmation and review the
              latest state before continuing.
            </Notice>
          )}
          <div className="dialog-actions">
            <button
              className="button"
              disabled={pending}
              onClick={() => {
                setConfirmation(null);
                setError('');
              }}
            >
              Cancel
            </button>
            <button
              className="button primary"
              disabled={
                pending ||
                !online ||
                project.role !== 'Owner' ||
                confirmation.expectedBoardRevision !== project.boardRevision ||
                (project.status === 'archived' &&
                  confirmation.kind !== 'restore')
              }
              onClick={() => void confirm()}
            >
              {pending
                ? 'Saving…'
                : confirmation.kind === 'ownership'
                  ? 'Confirm transfer'
                  : confirmation.kind === 'archive'
                    ? 'Confirm archive'
                    : 'Confirm restore'}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}
