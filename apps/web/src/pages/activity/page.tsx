import { useParams } from 'react-router';
import { useProjectControls } from '../../app/layouts/project-layout';
import {
  ActivityFeed,
  ActivityTimeline,
} from '../../features/activity/activity-feed';

export function ActivityPage() {
  const { projectId = '' } = useParams();
  const { sampleBoard } = useProjectControls();
  if (sampleBoard)
    return (
      <section className="activity-section" aria-label="Project activity">
        <h2>Project activity</h2>
        <ActivityTimeline
          items={sampleBoard.activity}
          projectId={sampleBoard.project.id}
        />
      </section>
    );
  return <ActivityFeed projectId={projectId} />;
}
