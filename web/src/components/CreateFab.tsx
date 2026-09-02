import { IconPlus } from "./Icons";

export function CreateFab(props: { onPress: () => void }) {
  return (
    <div className="create-fab-wrap">
      <button type="button" className="create-fab" onClick={props.onPress} aria-label="Create a new Proof">
        <IconPlus />
      </button>
    </div>
  );
}
