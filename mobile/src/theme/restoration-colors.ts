import { colorsForScheme, type ColorScheme, type ThemeColors } from './tokens';

export function restorationColors(scheme: ColorScheme): ThemeColors {
  const base=colorsForScheme(scheme,true);
  return scheme==='light' ? {
    ...base, background:'#F1EEE7',surface:'#FCFAF5',surfaceElevated:'#FCFAF5',surfacePressed:'#ECE8DF',inputBackground:'#FCFAF5',
    textPrimary:'#202724',textSecondary:'#56615C',textMuted:'#56615C',border:'#D9D4C8',divider:'#D9D4C8',controlBorder:'#737D77',
    primary:'#245FC4',primaryHover:'#1D51A8',primaryPressed:'#1D51A8',textOnPrimary:'#FFFFFF',accent:'#245FC4',accentText:'#245FC4',accentPressed:'#1D51A8',accentSoft:'#E8F0FE',accentSoftBorder:'#C3D4F4',
    success:'#187153',successText:'#187153',successSoft:'#E6F2EA',successSoftBorder:'#AECFBC',warning:'#8C5A08',warningText:'#8C5A08',warningSoft:'#FFF2D9',error:'#AF303A',errorMuted:'#AF303A',errorSoft:'#FCECEF',
    disabledBackground:'#ECE8DF',disabledText:'#56615C',navigationBar:'#FCFAF5',statusBar:'#FCFAF5',fab:'#245FC4',
  } : {
    ...base,background:'#191D1B',surface:'#242A26',surfaceElevated:'#242A26',surfacePressed:'#303932',inputBackground:'#242A26',
    textPrimary:'#F1F4F1',textSecondary:'#B7C2BA',textMuted:'#B7C2BA',border:'#45514A',divider:'#45514A',controlBorder:'#8B9990',
    primary:'#245FC4',primaryHover:'#1D51A8',primaryPressed:'#1D51A8',textOnPrimary:'#FFFFFF',accent:'#8CB7FF',accentText:'#8CB7FF',accentPressed:'#709FE9',accentSoft:'#263D5D',accentSoftBorder:'#455B7D',
    success:'#88D6B2',successText:'#88D6B2',successSoft:'#253E31',successSoftBorder:'#4D7561',warning:'#F2CA87',warningText:'#F2CA87',warningSoft:'#433723',error:'#FFADB4',errorMuted:'#FFADB4',errorSoft:'#482E33',
    disabledBackground:'#303932',disabledText:'#B7C2BA',navigationBar:'#242A26',statusBar:'#242A26',fab:'#245FC4',
  };
}
