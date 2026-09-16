import sansRegular from '../report-fonts/ArcReportSans-Regular.ttf?url';
import sansMedium from '../report-fonts/ArcReportSans-Medium.ttf?url';
import sansBold from '../report-fonts/ArcReportSans-Bold.ttf?url';
import monoRegular from '../report-fonts/ArcReportMono-Regular.ttf?url';
import monoMedium from '../report-fonts/ArcReportMono-Medium.ttf?url';

/* the report pdf's type, fetched the first time a report is drawn.
 *
 * the pages use woff2 through fontsource, which a pdf cannot embed, so the report
 * carries its own truetype copies: space grotesk and ibm plex mono cut down to
 * latin (about 33kb each) and renamed "arc report sans" and "arc report mono", as
 * the open font license asks of a modified copy. licences are beside the files.
 *
 * one fetch per session, shared by every report. a failure clears the cache so the
 * next attempt can retry, and report-pdf.js falls back to the built-in fonts rather
 * than refusing to draw.
 */

const FILES = {
  'ArcReportSans-Regular.ttf': sansRegular,
  'ArcReportSans-Medium.ttf': sansMedium,
  'ArcReportSans-Bold.ttf': sansBold,
  'ArcReportMono-Regular.ttf': monoRegular,
  'ArcReportMono-Medium.ttf': monoMedium,
};

let pending = null;

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  /* chunked: spreading thirty thousand bytes into one fromCharCode call overflows
     the argument limit in some engines. */
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function loadReportFonts() {
  if (!pending) {
    pending = Promise.all(
      Object.entries(FILES).map(async ([file, url]) => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`font ${file}: ${response.status}`);
        return [file, toBase64(await response.arrayBuffer())];
      }),
    )
      .then(Object.fromEntries)
      .catch((error) => {
        pending = null;
        throw error;
      });
  }
  return pending;
}
