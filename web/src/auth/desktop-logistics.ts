interface DesktopContext {userId:string;organizationId:string;environment:string;locationId:string|null}
// Only the isolated Logistics window sets this user agent marker. The expected identity
// selects the UI session. The backend independently authorizes every record request.
export function desktopLogisticsContext(): DesktopContext | undefined {
  if (!navigator.userAgent.includes('PackProofLogistics/1')) return undefined;
  const key = 'packproof.desktop-logistics-context';
  try {
    const previous = sessionStorage.getItem(key);
    if (previous) return JSON.parse(previous) as DesktopContext;
    const params = new URLSearchParams(location.search);
    const userId = params.get('desktopUser'), organizationId = params.get('organizationId'), environment = params.get('environment');
    if (userId && organizationId && environment) {
      const context = {userId,organizationId,environment,locationId:params.get('locationId')};
      sessionStorage.setItem(key,JSON.stringify(context));
      return context;
    }
  } catch { /* An unbound desktop window cannot display records. */ }
  return {userId:'',organizationId:'',environment:'',locationId:null};
}
