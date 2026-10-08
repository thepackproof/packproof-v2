# Runtime interface fonts

The `Inter-Regular.ttf`, `Inter-SemiBold.ttf`, and `Inter-Bold.ttf` filenames remain stable because `ThemeProvider` loads them at runtime under the existing Expo aliases `Inter`, `Inter-SemiBold`, and `Inter-Bold`.

Their internal family is **PackProof Sans**, a metadata-corrected derivative of the bundled Inter 4.001 static faces. The original files all identified themselves as `Inter-Regular`, causing iOS to reject the second and third registrations as duplicate font names and display regular weight for the other aliases. The corrected PostScript names are `PackProofSans-Regular`, `PackProofSans-SemiBold`, and `PackProofSans-Bold`.

The glyph outlines, character maps, metrics, OpenType layout, and original 400/600/700 weights are unchanged. Only the name table, Bold's style flags, and the required font checksums were corrected. The legacy SemiBold family is `PackProof Sans SemiBold` with a Regular subfamily; its typographic family/subfamily are `PackProof Sans` / `SemiBold`. Regular and Bold retain their normal style-linking pair. All three have distinct full names and share the typographic family.

The derivative name distinguishes these modified assets from the upstream fonts. Original copyright, author, trademark, and SIL Open Font License metadata is retained, as is [OFL-Inter.txt](./assets/fonts/OFL-Inter.txt). These modified fonts remain under that same license. The filename and JavaScript aliases are compatibility identifiers, not a claim that this metadata revision is an upstream release.

Run `node --test tests/font-assets.test.cjs` from `mobile/` to check runtime identity, static weight/style metadata, distinct outlines, valid font checksums, and license attribution. These checks supplement native screenshot inspection; they do not by themselves prove that a particular installed app loaded the fonts.

