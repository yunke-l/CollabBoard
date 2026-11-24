import { useRef, useState, type FormEvent } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import {
  commentCapabilities,
  createCommentSchema,
  updateCommentSchema,
  projectCapabilities,
  type CursorPage,
  type Project,
  type Task,
  type TaskComment,
} from '@collabboard/contracts';
import { useSession } from '../../app/providers/session';
import { api, ApiError } from '../../shared/api/client';
import {
  Avatar,
  ErrorState,
  LoadingState,
  Notice,
} from '../../shared/ui/common';
import { useOnline } from '../../shared/lib/use-online';
import { useProjectAccess } from '../projects/use-project-access';

export function CommentContent({ comment }: { comment: TaskComment }) {
  return (
    <>
      {' '}
      <div className="comment-heading">
        <Avatar name={comment.authorName} userId={comment.authorId} />
        <strong>{comment.authorName}</strong>
        {!comment.authorActive && (
          <small className="muted">Left the project</small>
        )}
        <time dateTime={comment.createdAt}>
          {new Date(comment.createdAt).toLocaleString('en')}
        </time>
      </div>
      <p className={comment.deletedAt ? 'comment-deleted' : 'plain-text'}>
        {comment.deletedAt ? 'Comment deleted' : comment.body}
      </p>
      {comment.editedAt && !comment.deletedAt && (
        <small className="muted">Edited</small>
      )}
    </>
  );
}

type Draft = { id: string; body: string; expectedVersion: number };
export function CommentSection({
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
  const query = useInfiniteQuery({
    queryKey: ['comments', project.id, task.id, user?.id],
    queryFn: ({ signal, pageParam }) =>
      api<CursorPage<TaskComment>>(
        `/tasks/${task.id}/comments${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ''}`,
        { signal },
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    refetchInterval: 30000,
    refetchOnMount: 'always',
    refetchOnReconnect: 'always',
  });
  useProjectAccess(project.id, query.error);
  const [body, setBody] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleteTarget, setDeleting] = useState<TaskComment | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [review, setReview] = useState<TaskComment | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const attempts = useRef(
    new Map<string, { content: string; requestId: string }>(),
  );
  const items = [
    ...new Map(
      query.data?.pages
        .flatMap((page) => page.items)
        .map((item) => [item.id, item]),
    ).values(),
  ];
  const deleting = items.some(
    (item) => item.id === deleteTarget?.id && !item.deletedAt,
  )
    ? deleteTarget
    : null;
  const canAdd = projectCapabilities(
    project.role,
    project.status,
    !!task.archivedAt,
    online,
  ).canAddComment;
  const canEditDraft =
    draft &&
    commentCapabilities(
      project.role,
      project.status,
      !!task.archivedAt,
      true,
      !!review?.deletedAt,
      online,
    ).canEdit;
  function request(key: string, values: object) {
    const content = JSON.stringify(values);
    if (attempts.current.get(key)?.content !== content)
      attempts.current.set(key, { content, requestId: crypto.randomUUID() });
    return { ...values, requestId: attempts.current.get(key)!.requestId };
  }
  async function refresh() {
    await Promise.all(
      ['comments', 'activity', 'task', 'board', 'members'].map((key) =>
        client.invalidateQueries({ queryKey: [key, project.id] }),
      ),
    );
  }
  async function latest(id: string) {
    setReviewing(true);
    try {
      setReview(await api<TaskComment>(`/comments/${id}`));
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Unable to load the latest comment. Your draft is kept.',
      );
    } finally {
      setReviewing(false);
    }
  }
  async function submit(event: FormEvent, editing: boolean) {
    event.preventDefault();
    if (
      pending ||
      disabled ||
      (editing ? !draft || !canEditDraft || conflict : !canAdd)
    )
      return;
    const key = editing ? `edit:${draft!.id}` : 'create';
    const values = editing
      ? { body: draft!.body, expectedVersion: draft!.expectedVersion }
      : { body };
    const parsed = (
      editing ? updateCommentSchema : createCommentSchema
    ).safeParse(request(key, values));
    if (!parsed.success) {
      setError(parsed.error.issues[0]!.message);
      return;
    }
    setPending(true);
    onPending(true);
    setError('');
    try {
      await api(
        editing ? `/comments/${draft!.id}` : `/tasks/${task.id}/comments`,
        { method: editing ? 'PATCH' : 'POST', body: parsed.data },
      );
      attempts.current.delete(key);
      if (editing) {
        setDraft(null);
        setReview(null);
        setConflict(false);
      } else setBody('');
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Unable to save the comment. Your draft is kept.',
      );
      if (
        editing &&
        failure instanceof ApiError &&
        ['VERSION_CONFLICT', 'COMMENT_DELETED'].includes(failure.detail.code)
      ) {
        setConflict(true);
        await latest(draft!.id);
      }
    } finally {
      await refresh();
      setPending(false);
      onPending(false);
    }
  }
  async function remove() {
    if (
      !deleting ||
      pending ||
      disabled ||
      !commentCapabilities(
        project.role,
        project.status,
        !!task.archivedAt,
        deleting.authorId === user?.id,
        false,
        online,
      ).canDelete
    )
      return;
    setPending(true);
    onPending(true);
    setError('');
    try {
      await api(`/comments/${deleting.id}`, {
        method: 'DELETE',
        body: request(`delete:${deleting.id}`, {
          expectedVersion: deleting.version,
        }),
      });
      attempts.current.delete(`delete:${deleting.id}`);
      setDeleting(null);
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : 'Unable to delete this comment.',
      );
      if (
        failure instanceof ApiError &&
        failure.detail.code === 'VERSION_CONFLICT'
      )
        setDeleting(null);
    } finally {
      await refresh();
      setPending(false);
      onPending(false);
    }
  }
  const denied =
    query.error instanceof ApiError &&
    [401, 403, 404].includes(query.error.status);
  const retry = () => {
    if (query.isFetchNextPageError) void query.fetchNextPage();
    else void query.refetch();
  };
  return (
    <section
      className="task-section comment-section"
      aria-label="Task comments"
    >
      <h2>
        Comments <span className="muted">({task.commentCount})</span>
      </h2>
      {!online && (
        <Notice>
          You are offline. Your comment drafts are kept; posting is paused.
        </Notice>
      )}
      {project.role === 'Viewer' && (
        <Notice>
          Only Owners and Editors can change comments. Your drafts are kept for
          copying.
        </Notice>
      )}
      {project.status !== 'active' ? (
        <Notice>
          This project is archived. Comment changes are paused and drafts are
          kept.
        </Notice>
      ) : task.archivedAt ? (
        <Notice>
          This task is archived. Existing comments can be deleted by their
          author or the Owner; adding and editing are paused.
        </Notice>
      ) : null}
      {error && (
        <p className="error-copy" role="alert">
          {error}
        </p>
      )}
      {canAdd || body ? (
        <form
          onSubmit={(event) => void submit(event, false)}
          className="comment-composer"
        >
          <label className="field">
            Comment
            <textarea
              aria-label="Comment"
              rows={3}
              value={body}
              readOnly={pending || project.role === 'Viewer'}
              onChange={(event) => setBody(event.target.value)}
            />
          </label>
          <small>{Array.from(body.trim()).length} / 2,000 characters</small>
          <button
            className="button primary"
            disabled={pending || disabled || !canAdd}
          >
            Post comment
          </button>
        </form>
      ) : null}
      {draft && (
        <form
          className="comment-editor"
          onSubmit={(event) => void submit(event, true)}
          aria-label="Edit comment"
        >
          <h3>Edit comment</h3>
          {conflict && (
            <div className="conflict-review" role="alert">
              <p>This comment has a newer version. Your draft is kept.</p>
              {review ? (
                <>
                  <p className="plain-text">
                    {review.deletedAt ? 'Comment deleted' : review.body}
                  </p>
                  <button
                    type="button"
                    className="button"
                    disabled={reviewing || !!review.deletedAt || !canEditDraft}
                    onClick={() => {
                      setDraft({ ...draft, expectedVersion: review.version });
                      setConflict(false);
                      setError('');
                    }}
                  >
                    Continue editing against comment version {review.version}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="button"
                  disabled={reviewing}
                  onClick={() => void latest(draft.id)}
                >
                  {reviewing ? 'Loading…' : 'Review latest comment'}
                </button>
              )}
            </div>
          )}
          <label className="field">
            Edit comment text
            <textarea
              aria-label="Edit comment text"
              autoFocus
              rows={4}
              value={draft.body}
              readOnly={pending || project.role === 'Viewer'}
              onChange={(event) =>
                setDraft({ ...draft, body: event.target.value })
              }
            />
          </label>
          <div className="dialog-actions">
            <button
              type="button"
              className="button"
              disabled={pending}
              onClick={() => {
                setDraft(null);
                setConflict(false);
                setReview(null);
              }}
            >
              Cancel comment edit
            </button>
            <button
              className="button primary"
              disabled={
                pending || disabled || !canEditDraft || conflict || reviewing
              }
            >
              Save comment
            </button>
          </div>
        </form>
      )}
      {query.isPending ? (
        <LoadingState />
      ) : query.isError && (!query.data || denied) ? (
        <ErrorState error={query.error} retry={retry} />
      ) : (
        <>
          {query.isError && <ErrorState error={query.error} retry={retry} />}
          {items.length ? (
            <div className="comment-list">
              {items.map((comment) => {
                const allowed = commentCapabilities(
                  project.role,
                  project.status,
                  !!task.archivedAt,
                  comment.authorId === user?.id,
                  !!comment.deletedAt,
                  online,
                );
                return (
                  <article className="comment-row" key={comment.id}>
                    <CommentContent comment={comment} />
                    {deleting?.id === comment.id ? (
                      <div
                        className="comment-delete-confirm"
                        role="group"
                        aria-label="Confirm comment deletion"
                      >
                        <span>Delete this comment?</span>
                        <button
                          type="button"
                          disabled={pending}
                          onClick={() => setDeleting(null)}
                        >
                          Keep comment
                        </button>
                        <button
                          type="button"
                          className="confirm-delete"
                          aria-label="Confirm comment deletion"
                          disabled={pending || disabled || !allowed.canDelete}
                          onClick={() => void remove()}
                        >
                          Delete
                        </button>
                      </div>
                    ) : (
                      (allowed.canEdit || allowed.canDelete) && (
                        <div className="comment-actions">
                          {allowed.canEdit && (
                            <button
                              className="button"
                              disabled={
                                pending || disabled || !!draft || !!deleting
                              }
                              onClick={() => {
                                setDraft({
                                  id: comment.id,
                                  body: comment.body!,
                                  expectedVersion: comment.version,
                                });
                                setConflict(false);
                                setReview(null);
                                setError('');
                              }}
                            >
                              Edit comment
                            </button>
                          )}
                          {allowed.canDelete && (
                            <button
                              className="button danger"
                              disabled={
                                pending || disabled || !!draft || !!deleting
                              }
                              onClick={() => {
                                setDeleting(comment);
                                setError('');
                              }}
                            >
                              Delete comment
                            </button>
                          )}
                        </div>
                      )
                    )}
                  </article>
                );
              })}
            </div>
          ) : !query.isError ? (
            <p>No comments yet.</p>
          ) : null}
          {query.hasNextPage && (
            <button
              className="button"
              disabled={query.isFetching}
              onClick={() => void query.fetchNextPage()}
            >
              {query.isFetchingNextPage ? 'Loading…' : 'Load more comments'}
            </button>
          )}
        </>
      )}
    </section>
  );
}
