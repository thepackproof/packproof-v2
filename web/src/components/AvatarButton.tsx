import { profileInitials } from "../format";

export function AvatarButton(props: {
  displayName?: string | null;
  username?: string | null;
  notify?: boolean;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      className="avatar-button"
      onClick={props.onPress}
      aria-label={props.notify ? "Account, pending invitations" : "Account"}
    >
      <span className="avatar-button-face">
        {profileInitials(props.displayName ?? null, props.username ?? "")}
      </span>
      {props.notify ? <span className="avatar-button-dot" aria-hidden="true" /> : null}
    </button>
  );
}
