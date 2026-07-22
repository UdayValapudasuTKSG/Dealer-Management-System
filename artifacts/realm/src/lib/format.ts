export function formatGuyanaDateTime(dateString: string) {
  const date = new Date(dateString);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Guyana",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function formatCurrency(amount: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "GYD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amount);
}
