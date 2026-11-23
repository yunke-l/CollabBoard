import { useRef, useState, type FormEvent } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import {
  initializeAttachmentSchema,
  projectCapabilities,
  type Attachment,
  type CursorPage,
  type Project,
  type Task,
  type UploadReservation,
} from '@collabboard/contracts';
import { useSession } from '../../app/providers/session';
import { api, ApiError, authorizedFetch } from '../../shared/api/client';
import { useOnline } from '../../shared/lib/use-online';
import { ErrorState, LoadingState, Notice } from '../../shared/ui/common';
import { useProjectAccess } from '../projects/use-project-access';

type Attempt = {
  file: File;
  requestId: string;
  completeId: string;
  reservation?: UploadReservation;
  uploaded?: boolean;
};
const typeByExtension: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  pdf: 'application/pdf',
  txt: 'text/plain',
};
export function AttachmentSection({
  project,
  task,
  disabled,
  onPending,
}: {
  project: Project;
  task: Task;
  disabled: boolean;
  onPending: (busy: boolean) => void;
}) {
  const { user } = useSession();
  const online = useOnline();
  const client = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [pending, setPending] = useState(false);
  const [stage, setStage] = useState('');
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState<Attachment | null>(null);
  const attempt = useRef<Attempt | null>(null);
  const deleteIds = useRef(new Map<string, string>());
  const query = useInfiniteQuery({
    queryKey: ['attachments', project.id, task.id, user?.id],
    queryFn: ({ signal, pageParam }) =>
      api<CursorPage<Attachment>>(
        `/tasks/${task.id}/attachments${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ''}`,
        { signal },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    refetchInterval: 30000,
    refetchOnMount: 'always',
    refetchOnReconnect: 'always',
  });
  useProjectAccess(project.id, query.error);
  const canUpload = projectCapabilities(
    project.role,
    project.status,
    !!task.archivedAt,
    online,
  ).canUploadAttachment;
  const canDelete = (item: Attachment) =>
    online &&
    project.status === 'active' &&
    project.role !== 'Viewer' &&
    (item.uploaderId === user?.id || project.role === 'Owner');
  async function refresh() {
    await Promise.all(
      ['attachments', 'activity', 'task', 'board', 'members'].map((key) =>
        client.invalidateQueries({ queryKey: [key, project.id] }),
      ),
    );
  }
  async function upload(event: FormEvent) {
    event.preventDefault();
    if (!file || !canUpload || pending || disabled) return;
    if (attempt.current?.file !== file)
      attempt.current = {
        file,
        requestId: crypto.randomUUID(),
        completeId: crypto.randomUUID(),
      };
    const current = attempt.current;
    const parsed = initializeAttachmentSchema.safeParse({
      originalName: file.name,
      sizeBytes: file.size,
      mediaType:
        typeByExtension[file.name.split('.').at(-1)!.toLowerCase()] ??
        file.type,
      requestId: current.requestId,
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]!.message);
      return;
    }
    setPending(true);
    onPending(true);
    setError('');
    try {
      if (
        !current.reservation ||
        (!current.uploaded &&
          new Date(current.reservation.upload.expiresAt).getTime() <=
            Date.now())
      ) {
        setStage('Reserving upload…');
        current.reservation = await api<UploadReservation>(
          `/tasks/${task.id}/attachments`,
          { method: 'POST', body: parsed.data },
        );
      }
      if (!current.uploaded) {
        setStage('Uploading file…');
        const response = await authorizedFetch(
          current.reservation.upload.path,
          {
            method: 'PUT',
            headers: {
              'X-Upload-Token': current.reservation.upload.token,
              'Content-Type': 'application/octet-stream',
            },
            body: file,
          },
        );
        if (!response.ok) {
          const detail = await response.json();
          throw new ApiError(response.status, detail);
        }
        current.uploaded = true;
      }
      setStage('Confirming file…');
      await api(`/attachments/${current.reservation.attachment.id}/complete`, {
        method: 'POST',
        body: { requestId: current.completeId },
      });
      attempt.current = null;
      setFile(null);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'The upload did not finish. Retry with the same file to continue safely.',
      );
    } finally {
      await refresh();
      setPending(false);
      onPending(false);
      setStage('');
    }
  }
  async function remove() {
    if (!deleting || !canDelete(deleting) || pending || disabled) return;
    setPending(true);
    onPending(true);
    setError('');
    try {
      if (!deleteIds.current.has(deleting.id))
        deleteIds.current.set(deleting.id, crypto.randomUUID());
      await api(`/attachments/${deleting.id}`, {
        method: 'DELETE',
        body: { requestId: deleteIds.current.get(deleting.id) },
      });
      deleteIds.current.delete(deleting.id);
      setDeleting(null);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Unable to delete the attachment.',
      );
    } finally {
      await refresh();
      setPending(false);
      onPending(false);
    }
  }
  async function download(item: Attachment) {
    setError('');
    try {
      const result = await api<{ url: string }>(
        `/attachments/${item.id}/download`,
        { method: 'POST' },
      );
      const link = document.createElement('a');
      link.href = result.url;
      link.download = item.originalName;
      document.body.append(link);
      link.click();
      link.remove();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Unable to download the attachment.',
      );
      await refresh();
    }
  }
  const items = [
    ...new Map(
      query.data?.pages
        .flatMap((page) => page.items)
        .map((item) => [item.id, item]),
    ).values(),
  ];
  const denied =
    query.error instanceof ApiError &&
    [401, 403, 404].includes(query.error.status);
  return (
    <section
      className="task-section attachment-section"
      aria-label="Task attachments"
    >
      <h2>
        Attachments <span className="muted">({task.attachmentCount})</span>
      </h2>
      <p className="muted">
        JPG, PNG, WebP, PDF, or TXT · up to 10 MiB each · 5 files per task
      </p>
      {!online && (
        <Notice>
          You are offline. Your selected file is kept; uploads and downloads are
          paused.
        </Notice>
      )}
      {(project.status !== 'active' ||
        task.archivedAt ||
        project.role === 'Viewer') && (
        <Notice>
          Uploading is paused for this task or your current role. Existing files
          remain available to members.
        </Notice>
      )}
      {error && (
        <p className="error-copy" role="alert">
          {error}
        </p>
      )}
      {(canUpload || file) && (
        <form
          className="attachment-upload"
          onSubmit={(event) => void upload(event)}
        >
          <label className="field">
            Attachment file
            <input
              type="file"
              aria-label="Attachment file"
              accept=".jpg,.jpeg,.png,.webp,.pdf,.txt"
              disabled={pending || !canUpload}
              onChange={(event) => {
                setFile(event.target.files?.[0] ?? null);
                setError('');
              }}
            />
          </label>
          {file && (
            <p className="plain-text">
              {file.name} ·{' '}
              {(file.size / 1024).toLocaleString('en', {
                maximumFractionDigits: 1,
              })}{' '}
              KiB
            </p>
          )}
          <button
            className="button primary"
            disabled={!file || !canUpload || pending || disabled}
          >
            {pending
              ? stage
              : attempt.current?.file === file
                ? 'Retry upload'
                : 'Upload attachment'}
          </button>
        </form>
      )}
      {deleting && (
        <div
          className="action-confirmation"
          role="group"
          aria-label="Confirm attachment deletion"
        >
          <p>
            Delete {deleting.originalName}? It will no longer be available for
            download.
          </p>
          <div className="dialog-actions">
            <button
              className="button"
              disabled={pending}
              onClick={() => setDeleting(null)}
            >
              Keep attachment
            </button>
            <button
              className="button danger"
              disabled={pending || disabled || !canDelete(deleting)}
              onClick={() => void remove()}
            >
              Confirm attachment deletion
            </button>
          </div>
        </div>
      )}
      {query.isPending ? (
        <LoadingState />
      ) : query.isError && (!query.data || denied) ? (
        <ErrorState error={query.error} retry={() => void query.refetch()} />
      ) : (
        <>
          {query.isError && (
            <ErrorState
              error={query.error}
              retry={() =>
                void (query.isFetchNextPageError
                  ? query.fetchNextPage()
                  : query.refetch())
              }
            />
          )}
          {items.length ? (
            <ul className="attachment-list">
              {items.map((item) => (
                <li key={item.id}>
                  <strong className="plain-text">{item.originalName}</strong>
                  <small>
                    {(item.sizeBytes / 1024).toLocaleString('en', {
                      maximumFractionDigits: 1,
                    })}{' '}
                    KiB · {item.uploaderName}
                    {!item.uploaderActive ? ' (left the project)' : ''}
                  </small>
                  <div className="comment-actions">
                    <button
                      className="button"
                      disabled={!online}
                      onClick={() => void download(item)}
                    >
                      Download {item.originalName}
                    </button>
                    {canDelete(item) && (
                      <button
                        className="button danger"
                        disabled={pending || disabled}
                        onClick={() => setDeleting(item)}
                      >
                        Delete attachment
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          ) : !query.isError ? (
            <p>No attachments yet.</p>
          ) : null}
          {query.hasNextPage && (
            <button
              className="button"
              disabled={query.isFetching}
              onClick={() => void query.fetchNextPage()}
            >
              Load more attachments
            </button>
          )}
        </>
      )}
    </section>
  );
}
