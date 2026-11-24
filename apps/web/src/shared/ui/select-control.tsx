import type { SelectHTMLAttributes } from 'react';
import type { LucideIcon } from 'lucide-react';

type SelectControlProps = SelectHTMLAttributes<HTMLSelectElement> & {
  icon: LucideIcon;
  active?: boolean;
};

export function SelectControl({
  icon: Icon,
  active,
  ...props
}: SelectControlProps) {
  return (
    <span className="select-control" data-active={active || undefined}>
      <Icon size={15} aria-hidden="true" />
      <select {...props} />
    </span>
  );
}
