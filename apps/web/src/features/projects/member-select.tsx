import type { ComponentProps } from 'react';
import { UserRound } from 'lucide-react';
import type { ProjectMember } from '@collabboard/contracts';
import { SelectControl } from '../../shared/ui/select-control';

type MemberOption = { value: string; label: string };

export function assigneeOptions(members: ProjectMember[] | undefined) {
  return members
    ?.filter((member) => member.role !== 'Viewer')
    .map((member) => ({ value: member.id, label: member.displayName }));
}

type MemberSelectProps = Omit<
  ComponentProps<typeof SelectControl>,
  'icon' | 'children' | 'value'
> & {
  options: MemberOption[] | undefined;
  value: string;
  placeholder: string;
  emptyLabel: string;
  loadFailed: boolean;
};

export function MemberSelect({
  options,
  value,
  placeholder,
  emptyLabel,
  loadFailed,
  disabled,
  ...props
}: MemberSelectProps) {
  const emptyMessage = !options
    ? loadFailed
      ? 'Members unavailable'
      : 'Loading members…'
    : !options.length
      ? emptyLabel
      : '';
  const missingSelection =
    value && !options?.some((option) => option.value === value);
  return (
    <SelectControl
      {...props}
      icon={UserRound}
      value={value}
      disabled={disabled || (!!emptyMessage && !value)}
    >
      <option value="">
        {value ? placeholder : emptyMessage || placeholder}
      </option>
      {options?.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
      {missingSelection && (
        <option disabled value={value}>
          {options ? 'Previously selected member unavailable' : emptyMessage}
        </option>
      )}
      {value && emptyMessage && options && (
        <option disabled>{emptyMessage}</option>
      )}
    </SelectControl>
  );
}
