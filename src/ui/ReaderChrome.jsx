/** Pure reader-chrome primitives. Stage data and navigation stay with each
 * reader; this component only standardizes their visual marker. */
export function ReaderStageMarker({ index, children }) {
  return <span className="reader-stage-marker">{children ?? index + 1}</span>;
}
