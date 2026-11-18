export function Icon({
  name,
  size = 32,
  className = "",
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  return (
    <img
      className={"pp-icon " + className}
      src={"./brand/connect/" + encodeURIComponent(name) + ".svg"}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}
export function Brand() {
  return (
    <div className="pp-brand" aria-label="PackProof Connect">
      <span className="pp-brand-mark">
        <img src="./brand/connect/packproof.png" alt="" draggable={false} />
      </span>
      <span>PackProof</span>
      <small>CONNECT</small>
    </div>
  );
}
