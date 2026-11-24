import type {
  ActivityEntry,
  SampleBoardSnapshot,
  Task,
  TaskComment,
} from '@collabboard/contracts';

const alex = 'Alex Morgan';
const jamie = 'Jamie Lee';
const sam = 'Sam Kim';

type SampleTask = {
  id: string;
  title: string;
  description: string;
  status: Task['status'];
  priority: Task['priority'];
  dueDate: string;
  assigneeName: string | null;
  discussion: [string, string][];
  attachments: { name: string; summary: string }[];
};

const examples: SampleTask[] = [
  {
    id: 'CB-024',
    title: 'Map the onboarding journey',
    status: 'todo',
    priority: 'high',
    dueDate: '2026-11-17',
    assigneeName: jamie,
    description:
      'Map the path from an invitation to the first completed task. Mark where a new teammate needs more guidance.',
    discussion: [
      [
        jamie,
        'The current map starts at sign-in. Should it start when the invitation arrives?',
      ],
      [
        sam,
        'Yes. In the walkthrough, two people missed the project name in the invitation.',
      ],
      [
        alex,
        'I marked that step in the outline. Let’s test it with the revised invitation copy.',
      ],
    ],
    attachments: [
      {
        name: 'onboarding-outline.md',
        summary:
          'Invitation email → sign-in → join the project → open the board → complete a first task.',
      },
    ],
  },
  {
    id: 'CB-025',
    title: 'Write the product introduction',
    status: 'todo',
    priority: 'medium',
    dueDate: '2026-11-21',
    assigneeName: alex,
    description:
      'Draft the short introduction visitors see above the sample board.',
    discussion: [
      [alex, 'I’m opening with the handoff from one teammate to another.'],
      [
        jamie,
        'The launch checklist would make a concrete example for the second sentence.',
      ],
    ],
    attachments: [],
  },
  {
    id: 'CB-026',
    title: 'Review keyboard navigation',
    status: 'todo',
    priority: 'medium',
    dueDate: '2026-11-23',
    assigneeName: sam,
    description:
      'Walk through the filters and task drawer using only the keyboard.',
    discussion: [],
    attachments: [
      {
        name: 'keyboard-checklist.md',
        summary:
          'Check tab order, visible focus, Escape to close, and focus returning to the original card.',
      },
    ],
  },
  {
    id: 'CB-027',
    title: 'Prepare the launch checklist',
    status: 'todo',
    priority: 'low',
    dueDate: '2026-11-25',
    assigneeName: null,
    description: 'Collect the final checks for publishing the website.',
    discussion: [
      [
        sam,
        'Please include a check that the sample board opens while signed out.',
      ],
    ],
    attachments: [],
  },
  {
    id: 'CB-018',
    title: 'Build the shared component library',
    status: 'in_progress',
    priority: 'high',
    dueDate: '2026-11-20',
    assigneeName: alex,
    description:
      'Bring the buttons, filters, and task cards into one component set.',
    discussion: [
      [alex, 'The button styles are ready for review.'],
      [sam, 'The focus ring is hard to see on a dark surface.'],
      [alex, 'I switched to the lighter ring and added a dark-mode example.'],
      [
        jamie,
        'That works in the task drawer too. I’ll use it for the filters.',
      ],
    ],
    attachments: [
      {
        name: 'component-inventory.md',
        summary:
          'Buttons, icon buttons, filters, drawers, and task cards share the same spacing scale.',
      },
      {
        name: 'focus-review.txt',
        summary: 'Use a visible focus ring on both light and dark surfaces.',
      },
    ],
  },
  {
    id: 'CB-020',
    title: 'Polish the project board layout',
    status: 'in_progress',
    priority: 'medium',
    dueDate: '2026-11-22',
    assigneeName: jamie,
    description: 'Check spacing and card labels at desktop and mobile widths.',
    discussion: [
      [jamie, 'The longer task titles now wrap to a second line.'],
      [
        sam,
        'On mobile I can still see the assignee and due date without scrolling sideways.',
      ],
    ],
    attachments: [
      {
        name: 'layout-review.txt',
        summary:
          'Desktop uses three columns. On mobile, the column selector keeps task cards at a readable width.',
      },
    ],
  },
  {
    id: 'CB-022',
    title: 'Test the invitation flow',
    status: 'in_progress',
    priority: 'medium',
    dueDate: '2026-11-22',
    assigneeName: sam,
    description: 'Walk through an invitation from a second browser session.',
    discussion: [
      [
        sam,
        'The editor invitation opens the correct board. Next up is checking the expired-link message.',
      ],
    ],
    attachments: [],
  },
  {
    id: 'CB-011',
    title: 'Define the visual direction',
    status: 'done',
    priority: 'medium',
    dueDate: '2026-11-14',
    assigneeName: alex,
    description: 'Agree on the palette and typography for the launch site.',
    discussion: [
      [alex, 'I put the two palette options in the review notes.'],
      [jamie, 'The cooler background makes the task cards easier to scan.'],
      [sam, 'Can we darken the small labels on the light theme?'],
      [alex, 'Updated the label color in both themes.'],
      [sam, 'Checked the revised labels. This is ready to use.'],
    ],
    attachments: [
      {
        name: 'palette-notes.md',
        summary:
          'Cool neutral backgrounds, darker labels, and one accent for primary actions.',
      },
      {
        name: 'type-notes.md',
        summary:
          'Use sentence case for actions and reserve larger headings for project and task titles.',
      },
    ],
  },
  {
    id: 'CB-013',
    title: 'Document project permissions',
    status: 'done',
    priority: 'low',
    dueDate: '2026-11-15',
    assigneeName: sam,
    description: 'Document what Owners, Editors, and Viewers can do.',
    discussion: [
      [sam, 'The role table now includes who can invite another member.'],
      [
        jamie,
        'Checked the Viewer row against the board. It matches what I see.',
      ],
    ],
    attachments: [
      {
        name: 'role-guide.md',
        summary:
          'Owners manage membership, Editors work on tasks, and Viewers can read the board and its discussions.',
      },
    ],
  },
  {
    id: 'CB-015',
    title: 'Set up the project structure',
    status: 'done',
    priority: 'low',
    dueDate: '2026-11-16',
    assigneeName: jamie,
    description:
      'Create the launch board and agree on the initial task groups.',
    discussion: [
      [
        jamie,
        'The three columns are ready. I’ve added tasks for design, implementation, and review.',
      ],
    ],
    attachments: [],
  },
];

const personId = (name: string) => name.toLowerCase().replaceAll(' ', '-');
const comments: TaskComment[] = [];
const activity: ActivityEntry[] = [];
function addActivity(
  task: Pick<SampleTask, 'id' | 'title'> | null,
  actor: string,
  action: string,
  createdAt: string,
  changes: ActivityEntry['changes'] = {},
) {
  activity.push({
    id: 'event-' + activity.length,
    projectId: 'sample',
    taskId: task?.id ?? null,
    taskTitle: task?.title ?? null,
    actorId: personId(actor),
    actorName: actor,
    actorActive: true,
    action,
    createdAt,
    changes,
    people: {},
  });
}

const createdAt = '2026-11-09T15:00:00.000Z';
addActivity(null, alex, 'project.created', createdAt);
const tasks = examples.map(({ discussion, attachments, ...task }, position) => {
  const actor = task.assigneeName ?? alex;
  const time = (day: number, minute: number) =>
    new Date(Date.UTC(2026, 10, day, 14 + position, minute)).toISOString();
  addActivity(task, actor, 'task.created', time(10, 0));
  discussion.forEach(([author, body], index) => {
    const date = time(11 + index, 10);
    comments.push({
      id: task.id + '-comment-' + index,
      projectId: 'sample',
      taskId: task.id,
      authorId: personId(author),
      authorName: author,
      authorActive: true,
      body,
      version: 1,
      createdAt: date,
      editedAt: null,
      deletedAt: null,
    });
    addActivity(task, author, 'comment.created', date);
  });
  if (task.status !== 'todo') {
    addActivity(task, actor, 'task.moved', time(12, 30), {
      before: { status: 'todo' },
      after: { status: 'in_progress' },
    });
    if (task.status === 'done')
      addActivity(task, actor, 'task.moved', time(15, 45), {
        before: { status: 'in_progress' },
        after: { status: 'done' },
      });
  }
  return {
    ...task,
    projectId: 'sample',
    position,
    version: 1,
    archivedAt: null,
    assigneeId: null,
    commentCount: discussion.length,
    attachmentCount: attachments.length,
  };
});

export const sampleBoard: SampleBoardSnapshot = {
  project: {
    id: 'sample',
    name: 'Website launch',
    description: '',
    status: 'active',
    role: 'Viewer',
    boardRevision: 1,
    createdAt,
  },
  tasks,
  comments,
  activity: activity.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
  attachments: examples.flatMap((task) =>
    task.attachments.map((file) => ({ ...file, taskId: task.id })),
  ),
};
