/**
 * Small inline SVG icons sized for sidebar/status-bar use. Single-color,
 * inherits `currentColor`. Keep the set minimal — add new icons only when a
 * feature needs one, not preemptively.
 */
interface IconProps {
  size?: number;
  className?: string;
  'aria-label'?: string;
}

function svgProps({ size = 16, className, ...rest }: IconProps) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    'aria-hidden': rest['aria-label'] ? undefined : true,
    className,
    ...rest,
  } as const;
}

export function PlayIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path d="M4.5 3 L12 8 L4.5 13 Z" fill="currentColor" />
    </svg>
  );
}

export function GearIcon(props: IconProps) {
  return (
    <svg {...svgProps(props)}>
      <path
        d="M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Zm5.9 3.2.9-.5a.5.5 0 0 0 .2-.6l-1-1.7a.5.5 0 0 0-.6-.2l-1 .3a4.2 4.2 0 0 0-.9-.5l-.2-1a.5.5 0 0 0-.5-.5h-2a.5.5 0 0 0-.5.5l-.2 1a4.2 4.2 0 0 0-.9.5l-1-.3a.5.5 0 0 0-.6.2l-1 1.7a.5.5 0 0 0 .2.6l.9.5a4.3 4.3 0 0 0 0 1l-.9.5a.5.5 0 0 0-.2.6l1 1.7a.5.5 0 0 0 .6.2l1-.3c.3.2.6.4.9.5l.2 1a.5.5 0 0 0 .5.5h2a.5.5 0 0 0 .5-.5l.2-1c.3-.1.6-.3.9-.5l1 .3a.5.5 0 0 0 .6-.2l1-1.7a.5.5 0 0 0-.2-.6l-.9-.5a4.3 4.3 0 0 0 0-1Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}
