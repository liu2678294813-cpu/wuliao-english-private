export default function Icon({ name, size = 20, className = "", title = "" }) {
  const labelProps = title
    ? { role: "img", "aria-label": title }
    : { "aria-hidden": "true" };

  return (
    <svg
      className={`ds-icon ${className}`.trim()}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      focusable="false"
      {...labelProps}
    >
      <use href={`/ui-icons.svg#${name}`} />
    </svg>
  );
}
