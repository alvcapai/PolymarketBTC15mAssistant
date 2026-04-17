export function inTradingHours(date = new Date(), startHourPst = 6, endHourPst = 17, allowWeekends = false) {
  const pst = new Date(date.toLocaleString("en-US", { timeZone: "America/Los_Angeles" }));
  const day = pst.getDay();
  if (!allowWeekends && (day === 0 || day === 6)) return false;
  const h = pst.getHours();
  return h >= startHourPst && h < endHourPst;
}
