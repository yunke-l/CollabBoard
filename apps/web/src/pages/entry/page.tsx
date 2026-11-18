import { Link } from 'react-router';
import { Check, Columns3, LockKeyhole, Users } from 'lucide-react';

export function EntryPage() {
  return (
    <main>
      <section className="hero">
        <span className="eyebrow">
          <span className="mini-mark" />A shared space for focused teams
        </span>
        <h1>
          Make progress.
          <br />
          <span>Make it together.</span>
        </h1>
        <p>
          From the first idea to the final handoff, keep your team's tasks,
          conversations, and next steps in one clear view.
        </p>
        <div className="hero-actions">
          <Link to="/sign-in" className="button primary">
            Open CollabBoard
          </Link>
          <Link to="/demo" className="button">
            Explore the sample board
          </Link>
        </div>
        <span className="hero-note">
          Built for small teams. Designed to keep things simple.
        </span>
      </section>
      <section
        className="entry-preview"
        aria-label="A preview of the task board"
      >
        <div className="preview-heading">
          <span className="project-symbol">
            <Columns3 size={21} />
          </span>
          <div>
            <strong>Website launch</strong>
            <p>A thoughtful refresh, from first idea to launch day.</p>
          </div>
          <span className="badge">Sample project</span>
        </div>
        <div className="preview-columns">
          {[
            [
              'To Do',
              ['Map the onboarding journey', 'Write the product introduction'],
            ],
            [
              'In Progress',
              [
                'Build the shared component library',
                'Polish the project board layout',
              ],
            ],
            [
              'Done',
              ['Define the visual direction', 'Document project permissions'],
            ],
          ].map(([title, items]) => (
            <div className="preview-column" key={title as string}>
              <h3>
                {title as string}
                <span>2</span>
              </h3>
              {(items as string[]).map((item, index) => (
                <div className="preview-card" key={item}>
                  <span className="task-reference">CB-0{24 - index}</span>
                  <h4>{item}</h4>
                  <span className="preview-meta">
                    {title === 'Done' ? (
                      <>
                        <Check size={14} />
                        Completed
                      </>
                    ) : (
                      'One clear next step'
                    )}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </section>
      <section className="feature-strip" aria-label="Why CollabBoard">
        {[
          [
            Columns3,
            'See the work clearly',
            'Three simple columns. A shared understanding of what comes next.',
          ],
          [
            Users,
            'Stay on the same page',
            'Give every task context, ownership, and room for conversation.',
          ],
          [
            LockKeyhole,
            'Share with confidence',
            'Project roles keep the right people in control of the right work.',
          ],
        ].map(([Icon, title, copy]) => {
          const Symbol = Icon as typeof Columns3;
          return (
            <article key={title as string}>
              <Symbol size={22} />
              <h2>{title as string}</h2>
              <p>{copy as string}</p>
            </article>
          );
        })}
      </section>
    </main>
  );
}
