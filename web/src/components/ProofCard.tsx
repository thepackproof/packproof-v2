import type { ProofCardModel } from "@packproof/copy/presentation";
import { StatusBadge } from "./StatusBadge";
import { IconCalendar, IconCar, IconChevron, IconCube } from "./Icons";

export function ProofCard(props: {
  model: ProofCardModel;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      className="proof-card"
      onClick={props.onPress}
      aria-label={`${props.model.title}. ${props.model.statusLabel}`}
    >
      {props.model.thumbnailUri ? (
        <img className="proof-card-thumb" src={props.model.thumbnailUri} alt="" />
      ) : (
        <span className="proof-card-thumb proof-card-thumb-fallback" aria-hidden="true">
          <IconCube />
        </span>
      )}
      <span className="proof-card-copy">
        <span className="proof-card-title">{props.model.title}</span>
        {props.model.priceLabel ? <span className="proof-card-price">{props.model.priceLabel}</span> : null}
        <StatusBadge label={props.model.statusLabel} />
        <span className="proof-card-meta">
          {props.model.shipping ? (
            <>
              <IconCar />
              {props.model.shipping}
            </>
          ) : null}
          {props.model.shipping && props.model.dateLabel ? <span aria-hidden="true">•</span> : null}
          {props.model.dateLabel ? (
            <>
              <IconCalendar />
              {props.model.dateLabel}
            </>
          ) : null}
        </span>
      </span>
      <IconChevron className="proof-card-chevron" />
    </button>
  );
}
