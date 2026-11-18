import {
  CalendarDays,
  CheckCircle2,
  Circle,
  CircleDashed,
  MessageSquare,
  Paperclip,
  SignalHigh,
  Plus,
} from 'lucide-react';
import { Link } from 'react-router';
import {
  statusLabels,
  taskStatuses,
  type Task,
  type TaskStatus,
} from '@collabboard/contracts';
import { Avatar } from '../../shared/ui/common';

export function dueDateLabel(task: Task) {
  if (!task.dueDate) return null;
  const [year, month, day] = task.dueDate.split('-').map(Number);
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric',
  }).format(new Date(year!, month! - 1, day));
}
export function isOverdue(task: Task) {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return !!task.dueDate && task.dueDate < today && task.status !== 'done';
}
export function TaskBoard({
  tasks,
  allTasks,
  taskUrl,
  selectedColumn,
  onColumnChange,
  onAdd,
}: {
  tasks: Task[];
  allTasks: Task[];
  taskUrl: (id: string) => string;
  selectedColumn: TaskStatus;
  onColumnChange: (status: TaskStatus) => void;
  onAdd?: (status: TaskStatus) => void;
}) {
  return (
    <>
      <div className="mobile-columns" role="group" aria-label="Board column">
        {taskStatuses.map((status) => (
          <button
            key={status}
            aria-pressed={selectedColumn === status}
            onClick={() => onColumnChange(status)}
          >
            {statusLabels[status]}
            <span>
              {allTasks.filter((task) => task.status === status).length}
            </span>
          </button>
        ))}
      </div>
      <div className="board-grid">
        {taskStatuses.map((status) => {
          const Icon =
            status === 'todo'
              ? Circle
              : status === 'in_progress'
                ? CircleDashed
                : CheckCircle2;
          const column = tasks.filter((task) => task.status === status);
          return (
            <section
              className={`board-column ${selectedColumn === status ? 'selected-column' : ''}`}
              key={status}
              aria-label={statusLabels[status]}
            >
              <header>
                <Icon size={20} />
                <h2>{statusLabels[status]}</h2>
                <span className="count">
                  {allTasks.filter((task) => task.status === status).length}
                </span>
                {onAdd && (
                  <button
                    className="icon-button"
                    aria-label={`Add task to ${statusLabels[status]}`}
                    onClick={() => onAdd(status)}
                  >
                    <Plus size={18} />
                  </button>
                )}
              </header>
              <div className="task-list">
                {column.map((task) => (
                  <Link
                    className={`task-card ${task.status === 'done' ? 'completed' : ''}`}
                    key={task.id}
                    to={taskUrl(task.id)}
                  >
                    <div className="card-top">
                      <span className="task-reference">
                        {task.id.startsWith('CB-')
                          ? task.id
                          : `CB-${task.id.slice(0, 6).toUpperCase()}`}
                      </span>
                      <span className={`priority ${task.priority}`}>
                        <SignalHigh size={13} />
                        {task.priority[0]!.toUpperCase() +
                          task.priority.slice(1)}
                      </span>
                    </div>
                    <h3>{task.title}</h3>
                    <div className="card-meta">
                      {task.dueDate && (
                        <span className={isOverdue(task) ? 'overdue' : ''}>
                          <CalendarDays size={14} />
                          {dueDateLabel(task)}
                        </span>
                      )}
                      <span aria-label={`${task.commentCount} comments`}>
                        <MessageSquare size={14} />
                        {task.commentCount}
                      </span>
                      {task.attachmentCount > 0 && (
                        <span
                          aria-label={`${task.attachmentCount} attachments`}
                        >
                          <Paperclip size={14} />
                          {task.attachmentCount}
                        </span>
                      )}
                      <Avatar name={task.assigneeName} />
                    </div>
                  </Link>
                ))}
                {column.length === 0 && (
                  <div className="column-empty">No tasks here yet.</div>
                )}
              </div>
              {onAdd && (
                <button className="add-task" onClick={() => onAdd(status)}>
                  <Plus size={16} />
                  Add task
                </button>
              )}
            </section>
          );
        })}
      </div>
    </>
  );
}
