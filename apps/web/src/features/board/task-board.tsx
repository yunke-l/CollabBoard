import { useState, type DragEvent } from 'react';
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

function insertionIndex(event: DragEvent<HTMLElement>, index: number) {
  const card = event.currentTarget.querySelector('.task-card')!;
  const { top, height } = card.getBoundingClientRect();
  return event.clientY < top + height / 2 ? index : index + 1;
}

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
  const draggable = !!onMove && !moving;
  const [draggedTask, setDraggedTask] = useState<Task | null>(null);
  const [dropHint, setDropHint] = useState<string | null>(null);
  function endDrag() {
    setDraggedTask(null);
    setDropHint(null);
  }
  function canDropIn(status: TaskStatus) {
    return (
      draggable && draggedTask && (canReorder || draggedTask.status !== status)
    );
  }
  function columnDragOver(event: DragEvent, status: TaskStatus) {
    if (!canDropIn(status)) return;
    event.preventDefault();
    const alreadyLast =
      draggedTask?.status === status &&
      !allTasks.some(
        (task) =>
          task.status === status && task.position > draggedTask.position,
      );
    setDropHint(alreadyLast ? null : status);
  }
  function dropInColumn(event: DragEvent, status: TaskStatus) {
    if (!onMove || !draggedTask || !canDropIn(status)) return;
    event.preventDefault();
    endDrag();
    if (
      draggedTask.status !== status ||
      allTasks.some(
        (task) =>
          task.status === status && task.position > draggedTask.position,
      )
    )
      onMove(draggedTask.id, status, null);
  }
  return (
    <>
      <div className="mobile-columns" role="group" aria-label="Board column">
        {taskStatuses.map((status) => (
          <button
            key={status}
            data-status={status}
            aria-pressed={selectedColumn === status}
            onClick={() => onColumnChange(status)}
            data-drop-target={dropHint === status || undefined}
            onDragOver={(event) => columnDragOver(event, status)}
            onDragLeave={() => setDropHint(null)}
            onDrop={(event) => {
              if (canDropIn(status)) {
                dropInColumn(event, status);
                onColumnChange(status);
              }
            }}
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
              onDragOver={(event) => columnDragOver(event, status)}
              onDragLeave={(event) => {
                if (
                  !event.currentTarget.contains(
                    event.relatedTarget as Node | null,
                  )
                )
                  setDropHint(null);
              }}
              data-drop-end={dropHint === status || undefined}
              onDrop={(event) => dropInColumn(event, status)}
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
                    data-drop-before={dropHint === task.id || undefined}
                    onDragOver={(event) => {
                      if (!canDropIn(status) || !draggedTask || !canReorder)
                        return;
                      event.preventDefault();
                      event.stopPropagation();
                      const slot = insertionIndex(event, index);
                      const before = column[slot]?.id;
                      const unchanged =
                        before === draggedTask.id ||
                        column[slot - 1]?.id === draggedTask.id;
                      setDropHint(unchanged ? null : (before ?? status));
                    }}
                    onDrop={(event) => {
                      if (
                        !onMove ||
                        !canDropIn(status) ||
                        !draggedTask ||
                        !canReorder
                      )
                        return;
                      event.preventDefault();
                      event.stopPropagation();
                      const slot = insertionIndex(event, index);
                      const before = column[slot]?.id ?? null;
                      endDrag();
                      if (
                        before !== draggedTask.id &&
                        column[slot - 1]?.id !== draggedTask.id
                      )
                        onMove(draggedTask.id, status, before);
                    }}
                  >
                    <Link
                      className={`task-card ${task.status === 'done' ? 'completed' : ''}`}
                      to={taskUrl(task.id)}
                      draggable={draggable}
                      onDragStart={(event) => {
                        if (!draggable) return;
                        event.dataTransfer.setData(
                          'application/x-collabboard-task',
                          task.id,
                        );
                        event.dataTransfer.effectAllowed = 'move';
                        const card = event.currentTarget;
                        const bounds = card.getBoundingClientRect();
                        event.dataTransfer.setDragImage(
                          card,
                          event.clientX - bounds.left,
                          event.clientY - bounds.top,
                        );
                        setDraggedTask(task);
                      }}
                      onDragEnd={endDrag}
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
