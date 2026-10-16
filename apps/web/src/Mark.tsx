export function Mark({ className = "land-mark" }: { className?: string }) {
  return (
    <div className={className} aria-hidden="true">
      <svg viewBox="0 0 32 32">
        <path fill="#ffffff" d="M16 6.2 24.8 13.8 16 26.2 7.2 13.8 16 6.2z" />
        <path fill="#ddd6fe" d="M16 6.2 24.8 13.8 16 14.6 7.2 13.8 16 6.2z" />
        <path fill="#ffffff" fillOpacity="0.42" d="M7.2 13.8 16 14.6 16 26.2 7.2 13.8z" />
        <path fill="#ffffff" d="M23.6 6.1c.16 1.05.78 1.78 1.9 2.05-1.12.27-1.74 1-1.9 2.05-.16-1.05-.78-1.78-1.9-2.05 1.12-.27 1.74-1 1.9-2.05z" />
      </svg>
    </div>
  );
}
