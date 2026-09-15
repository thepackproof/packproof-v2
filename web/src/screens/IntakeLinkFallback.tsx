/** A handoff locator grants no access and is never redeemed by this web fallback. */
export function IntakeLinkFallback({ onQueue }: { onQueue: () => void }) {
  return <section className="panel stack" style={{ maxWidth: 560, margin: "2rem auto" }}>
    <h1>Your packing queue</h1>
    <p>Open PackProof on your phone and sign in to the account that prepared this order. Your saved orders will appear in Needs attention.</p>
    <button className="btn" onClick={onQueue}>Continue to packing queue</button>
    <p className="note">If PackProof is not installed, use your team's installation link, then sign in to the same account. You can also use the packing queue in this browser.</p>
  </section>;
}

export function IntakeSignInContext() {
  return <div className="note" role="note">
    <p>Sign in to open your packing queue or order. This link does not grant access to anyone else's records.</p>
    <p>If you install PackProof on your phone, sign in to the same account to find your saved orders in Needs attention.</p>
  </div>;
}
