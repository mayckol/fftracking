interface IconProps {
  open?: boolean;
}

export function FolderIcon({ open }: IconProps) {
  return (
    <svg className="ic ic-folder" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      {open ? (
        <path
          d="M1.5 5.5 2.6 13a1 1 0 0 0 1 .8h9.2a1 1 0 0 0 1-.8l.9-5.2a.6.6 0 0 0-.6-.7H4a1 1 0 0 0-1 .8L2.4 13M1.5 5.5v-1A1 1 0 0 1 2.5 3.5h3.3a1 1 0 0 1 .7.3l1 .9a1 1 0 0 0 .7.3h4.6a1 1 0 0 1 1 1V7"
          stroke="currentColor"
          strokeWidth="1.1"
          strokeLinejoin="round"
        />
      ) : (
        <path
          d="M1.6 4.5a1 1 0 0 1 1-1h3.3a1 1 0 0 1 .7.3l1 .9a1 1 0 0 0 .7.3h4.6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H2.6a1 1 0 0 1-1-1V4.5Z"
          stroke="currentColor"
          strokeWidth="1.1"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

export function FileIcon() {
  return (
    <svg className="ic ic-file" width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M4 1.8h4.7L12 5.1V14a.6.6 0 0 1-.6.6H4a.6.6 0 0 1-.6-.6V2.4A.6.6 0 0 1 4 1.8Z"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
      <path d="M8.4 1.9v3.2h3.2" stroke="currentColor" strokeWidth="1.1" strokeLinejoin="round" />
    </svg>
  );
}
