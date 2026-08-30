import { shortId } from "../format";

export function CopyableId(props: { value: string; label: string }) {
  return (
    <span className="copyable">
      <code className="mono" title={props.value}>
        {shortId(props.value)}
      </code>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(props.value);
        }}
      >
        Copy {props.label}
      </button>
    </span>
  );
}
