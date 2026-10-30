const HAS_ZONE_DESIGNATOR = /(?:[zZ]|[+-]\d{2}:\d{2})$/;

// A timestamp with no zone designator is UTC (as the backend reads it), whereas
// Date.parse would read it as local time. NaN when unparseable.
export function timestampMs(timestamp: string): number {
  return Date.parse(HAS_ZONE_DESIGNATOR.test(timestamp) ? timestamp : `${timestamp}Z`);
}
