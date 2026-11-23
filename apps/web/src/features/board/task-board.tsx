import {
  CalendarDays,
  CheckCircle2,
  Circle,
  CircleDashed,
  MessageSquare,
  Paperclip,
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
  onMove,
  canReorder = false,
  moving = false,
}: {
  tasks: Task[];
  allTasks: Task[];
  taskUrl: (id: string) => string;
  selectedColumn: TaskStatus;
  onColumnChange: (status: TaskStatus) => void;
  onAdd?: (status: TaskStatus) => void;
  onMove?: (
    taskId: string,
    status: TaskStatus,
    beforeTaskId: string | null,
  ) => void;
  canReorder?: boolean;
  moving?: boolean;
}) {
  return (
    <>
      <div className="mobile-columns" role="group" aria-label="Board column">
        {taskStatuses.map((status) => (
          <button
            key={status}
            data-status={status}
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
          const column = tasks
            .filter((task) => task.status === status)
            .sort((a, b) => a.position - b.position);
          return (
            <section
              className={`board-column ${selectedColumn === status ? 'selected-column' : ''}`}
              key={status}
              data-status={status}
              aria-label={statusLabels[status]}
              onDragOver={(event) => {
                if (onMove && canReorder && !moving) event.preventDefault();
              }}
              onDrop={(event) => {
                if (!onMove || !canReorder || moving) return;
                event.preventDefault();
                const id = event.dataTransfer.getData(
                  'application/x-collabboard-task',
                );
                if (allTasks.some((task) => task.id === id))
                  onMove(id, status, null);
              }}
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
                {column.map((task, index) => (
                  <article
                    className="task-card-shell"
                    key={task.id}
                    onDragOver={(event) => {
                      if (onMove && canReorder && !moving) {
                        event.preventDefault();
                        event.stopPropagation();
                      }
                    }}
                    onDrop={(event) => {
                      if (!onMove || !canReorder || moving) return;
                      event.preventDefault();
                      event.stopPropagation();
                      const id = event.dataTransfer.getData(
                        'application/x-collabboard-task',
                      );
                      if (
                        id !== task.id &&
                        allTasks.some((item) => item.id === id)
                      )
                        onMove(id, status, task.id);
                    }}
                  >
                    <Link
                      className={`task-card ${task.status === 'done' ? 'completed' : ''}`}
                      to={taskUrl(task.id)}
                      draggable={false}
                    >
                      <div className="card-top">
                        <span className="task-reference">
                          {task.id.startsWith('CB-')
                            ? task.id
                            : `CB-${task.id.slice(0, 6).toUpperCase()}`}
                        </span>
                        <span className={`priority ${task.priority}`}>
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
                        <Avatar
                          name={task.assigneeName}
                          userId={task.assigneeId}
                        />
                      </div>
                    </Link>
                    {onMove && (
                      <div className="task-card-actions">
                        <button
                          className="icon-button drag-handle"
                          aria-label={`Drag ${task.title}`}
                          title={
                            canReorder
                              ? 'Drag to reorder'
                              : 'Clear filters to reorder'
                          }
                          disabled={!canReorder || moving}
                          draggable={canReorder && !moving}
                          onDragStart={(event) => {
                            event.dataTransfer.setData(
                              'application/x-collabboard-task',
                              task.id,
                            );
                            event.dataTransfer.effectAllowed = 'move';
                          }}
                        >
                          ↕
                        </button>
                        <label>
                          <span className="sr-only">Move {task.title} to</span>
                          <select
                            aria-label={`Move ${task.title} to`}
                            value=""
                            disabled={moving}
                            onChange={(event) => {
                              if (event.target.value)
                                onMove(
                                  task.id,
                                  event.target.value as TaskStatus,
                                  null,
                                );
                            }}
                          >
                            <option value="">Move to…</option>
                            {taskStatuses.map((target) => (
                              <option value={target} key={target}>
                                {statusLabels[target]}
                              </option>
                            ))}
                          </select>
                        </label>
                        <button
                          className="icon-button"
                          aria-label={`Move ${task.title} up`}
                          disabled={!canReorder || moving || index === 0}
                          onClick={() =>
                            onMove(task.id, status, column[index - 1]!.id)
                          }
                        >
                          ↑
                        </button>
                        <button
                          className="icon-button"
                          aria-label={`Move ${task.title} down`}
                          disabled={
                            !canReorder || moving || index === column.length - 1
                          }
                          onClick={() =>
                            onMove(
                              task.id,
                              status,
                              column[index + 2]?.id ?? null,
                            )
                          }
                        >
                          ↓
                        </button>
                      </div>
                    )}
                  </article>
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
