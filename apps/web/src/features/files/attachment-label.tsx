import { File, FileText, Image } from 'lucide-react';

const formats = new Map<string, [string, typeof File]>([
  ['jpg', ['JPEG image', Image]],
  ['jpeg', ['JPEG image', Image]],
  ['png', ['PNG image', Image]],
  ['webp', ['WebP image', Image]],
  ['pdf', ['PDF document', FileText]],
  ['txt', ['Text document', FileText]],
  ['md', ['Markdown document', FileText]],
]);

export function AttachmentLabel({
  name,
  detail,
}: {
  name: string;
  detail?: string;
}) {
  const extension = name.match(/\.([^.]+)$/)?.[1]?.toLowerCase() ?? '';
  const [format, Icon] = formats.get(extension) ?? ['File', File];
  return (
    <>
      <span
        className="attachment-icon"
        data-format={extension}
        aria-hidden="true"
      >
        <Icon size={20} />
      </span>
      <span className="attachment-label">
        <strong>{name}</strong>
        <small>
          {format}
          {detail && ` · ${detail}`}
        </small>
      </span>
    </>
  );
}
