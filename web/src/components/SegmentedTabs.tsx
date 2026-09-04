import type { ReactNode } from "react";

export function SegmentedTabs<T extends string>(props: {
  options: Array<{ id: T; label: string; icon: ReactNode }>;
  selected: T;
  onSelect: (id: T) => void;
  label: string;
}) {
  return (
    <div className="segmented" role="tablist" aria-label={props.label}>
      {props.options.map((option, index) => {
        const selected = props.selected === option.id;
        return (
          <button
            key={option.id}
            type="button"
            className="segmented-tab"
            role="tab"
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            onKeyDown={(event) => {
              const next = event.key === "ArrowRight" ? (index + 1) % props.options.length
                : event.key === "ArrowLeft" ? (index - 1 + props.options.length) % props.options.length
                : event.key === "Home" ? 0 : event.key === "End" ? props.options.length - 1 : null;
              if (next == null) return;
              event.preventDefault();
              props.onSelect(props.options[next].id);
              event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role=tab]")[next]?.focus();
            }}
            onClick={() => props.onSelect(option.id)}
          >
            {option.icon}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
