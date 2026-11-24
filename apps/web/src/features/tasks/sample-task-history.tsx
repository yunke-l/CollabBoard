import type { SampleBoardSnapshot } from '@collabboard/contracts';
import { ChevronDown } from 'lucide-react';
import { ActivityTimeline } from '../activity/activity-feed';
import { CommentContent } from '../comments/comment-section';
import { AttachmentLabel } from '../files/attachment-label';

export function SampleTaskHistory({
  board,
  taskId,
}: {
  board: SampleBoardSnapshot;
  taskId: string;
}) {
  const comments = board.comments.filter(
    (comment) => comment.taskId === taskId,
  );
  const files = board.attachments.filter((file) => file.taskId === taskId);
  return (
    <>
      <section
        className="task-section comment-section"
        aria-label="Task comments"
      >
        <h2>
          Comments <span className="muted">({comments.length})</span>
        </h2>
        {comments.length ? (
          <div className="comment-list">
            {comments.map((comment) => (
              <article key={comment.id} className="comment-row">
                <CommentContent comment={comment} />
              </article>
            ))}
          </div>
        ) : (
          <p>No comments yet.</p>
        )}
      </section>
      <section className="task-section" aria-label="Task attachments">
        <h2>
          Attachments <span className="muted">({files.length})</span>
        </h2>
        {files.length ? (
          <ul className="attachment-list">
            {files.map((file) => (
              <li key={file.name}>
                <details className="attachment-preview">
                  <summary className="attachment-card">
                    <AttachmentLabel name={file.name} />
                    <ChevronDown
                      className="attachment-chevron"
                      size={17}
                      aria-hidden="true"
                    />
                  </summary>
                  <p className="plain-text">{file.summary}</p>
                </details>
              </li>
            ))}
          </ul>
        ) : (
          <p>No attachments yet.</p>
        )}
      </section>
      <section
        className="task-section activity-section"
        aria-label="Task activity"
      >
        <h2>Activity</h2>
        <ActivityTimeline
          items={board.activity.filter((entry) => entry.taskId === taskId)}
          projectId={board.project.id}
          taskId={taskId}
        />
      </section>
    </>
  );
}
