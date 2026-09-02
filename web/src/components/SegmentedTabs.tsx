import type { ReactNode } from "react";

export function SegmentedTabs<T extends string>(props: {
  options: Array<{ id: T; label: string; icon: ReactNode }>;
  selected: T;
  onSelect: (id: T) => void;
  label: string;
}) {
  return (
    <div className="segmented" role="tablist" aria-label={props.label}>
      {props.options.map((option) => {
        const selected = props.selected === option.id;
        return (
          <button
            key={option.id}
            type="button"
            className="segmented-tab"
            role="tab"
            aria-selected={selected}
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
