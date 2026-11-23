import { Link } from 'react-router';
import {
  CalendarDays,
  Check,
  CircleCheck,
  CircleDashed,
  Columns3,
  MessageSquare,
  Paperclip,
} from 'lucide-react';
import { useSession } from '../../app/providers/session';
import { Avatar } from '../../shared/ui/common';

function CollaborationScene() {
  return (
    <figure
      className="entry-scene"
      aria-label="An example of project collaboration"
    >
      <div className="entry-scene-canvas">
        <div className="entry-scene-heading">
          <div className="entry-scene-project">
            <span className="entry-project-icon">
              <Columns3 size={19} aria-hidden="true" />
            </span>
            <span>Launch day</span>
          </div>
          <div className="avatar-group" aria-label="The project team">
            <Avatar name="Jamie Lee" />
            <Avatar name="Alex Morgan" />
            <Avatar name="Sam Kim" />
          </div>
        </div>

        <div className="entry-scene-task">
          <div className="entry-task-topline">
            <span className="entry-task-reference">CB-018</span>
            <span className="entry-task-status">
              <CircleDashed size={14} aria-hidden="true" />
              In progress
            </span>
          </div>
          <h2>Bring the launch page to life</h2>
          <p>A clear first impression, down to the last detail.</p>
          <dl className="entry-task-details">
            <div>
              <dt>Assigned to</dt>
              <dd>
                <Avatar name="Jamie Lee" />
                Jamie Lee
              </dd>
            </div>
            <div>
              <dt>Due date</dt>
              <dd>
                <CalendarDays size={17} aria-hidden="true" />
                Friday
              </dd>
            </div>
          </dl>
          <div className="entry-task-context">
            <span>
              <MessageSquare size={15} aria-hidden="true" />2 comments
            </span>
            <span>
              <Paperclip size={15} aria-hidden="true" />1 attachment
            </span>
          </div>
        </div>

        <div className="entry-scene-comment">
          <Avatar name="Alex Morgan" />
          <div>
            <strong>Alex Morgan</strong>
            <p>Ready for your review. The latest design is attached!</p>
            <span className="entry-scene-file">
              <Paperclip size={14} aria-hidden="true" />
              launch-design.fig
            </span>
          </div>
        </div>

        <div className="entry-scene-completed">
          <span className="entry-completed-icon">
            <Check size={17} aria-hidden="true" />
          </span>
          <div>
            <strong>Visual direction approved</strong>
          </div>
        </div>
      </div>
    </figure>
  );
}

export function EntryPage() {
  const { user } = useSession();
  const startPath = user ? '/projects' : '/sign-in';

  return (
    <main className="entry-page">
      <section className="entry-hero" aria-labelledby="entry-title">
        <div className="entry-hero-copy">
          <h1 id="entry-title">
            Everyone knows <span>what’s next.</span>
          </h1>
          <p className="entry-hero-description">
            Keep tasks, owners, and conversations together on one shared board.
            Less chasing updates. More moving forward.
          </p>
          <div className="entry-hero-actions">
            <Link to={startPath} className="button primary">
              Start a project
            </Link>
            <Link to="/demo" className="button">
              View sample board
            </Link>
          </div>
        </div>
        <CollaborationScene />
      </section>

      <section
        className="entry-benefits"
        aria-labelledby="entry-benefits-title"
      >
        <div className="entry-section-heading">
          <h2 id="entry-benefits-title">
            Less “where are we?”
            <br />
            More “here we go.”
          </h2>
        </div>
        <div className="entry-benefit-grid">
          <article className="entry-benefit">
            <div className="entry-benefit-example entry-example-tasks">
              <div>
                <CircleDashed size={18} aria-hidden="true" />
                <span>Review the launch copy</span>
                <span className="entry-example-label">In progress</span>
              </div>
              <div>
                <CircleCheck size={18} aria-hidden="true" />
                <span>Define the visual direction</span>
                <Check size={15} aria-label="Completed" />
              </div>
            </div>
            <h3>See the next step.</h3>
            <p>
              From to-do to done, keep the plan in view and know what needs your
              attention.
            </p>
          </article>
          <article className="entry-benefit">
            <div className="entry-benefit-example entry-example-owner">
              <Avatar name="Jamie Lee" />
              <div>
                <strong>Jamie Lee</strong>
                <span>Taking the lead on design</span>
              </div>
              <span className="entry-owner-label">Assigned</span>
            </div>
            <h3>Give every task an owner.</h3>
            <p>
              Make responsibilities clear, so everyone knows where they can make
              a difference.
            </p>
          </article>
          <article className="entry-benefit">
            <div className="entry-benefit-example entry-example-context">
              <div>
                <MessageSquare size={17} aria-hidden="true" />
                <span>“The latest version is right here.”</span>
              </div>
              <span className="entry-example-attachment">
                <Paperclip size={15} aria-hidden="true" />
                launch-assets.zip
              </span>
            </div>
            <h3>Keep the context close.</h3>
            <p>
              Keep comments and files with the task, so the next person can pick
              up right where you left off.
            </p>
          </article>
        </div>
      </section>

      <section className="entry-start" aria-labelledby="entry-start-title">
        <div>
          <h2 id="entry-start-title">Your next project starts here.</h2>
          <p>Create a project, invite your team, and move work forward.</p>
        </div>
        <Link to={startPath} className="button primary">
          Start a project
        </Link>
      </section>
    </main>
  );
}
