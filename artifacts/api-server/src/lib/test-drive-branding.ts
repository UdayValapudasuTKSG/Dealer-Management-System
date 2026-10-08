/** Customer-facing test-drive locations supplied by the dealerships.
 * Keep these scoped to named dealerships, never as another dealer's fallback.
 */
export function testDriveBranding(dealer: {
  name: string;
  brandName: string | null;
  themeColor: string | null;
  address: string | null;
}) {
  const key = dealer.name.trim().toLowerCase();
  const known = key === "gt automotive"
    ? { name: "GT Automotive", address: "220 Camp St, Georgetown" }
    : key === "cam motors"
      ? { name: "CAM Motors", address: "5 Vlissengen Road and Dowding Street, Georgetown" }
      : null;
  return {
    dealerName: known?.name ?? (dealer.brandName?.trim() || dealer.name),
    showroomAddress: known?.address ?? dealer.address,
    brandColor: dealer.themeColor && /^#[0-9a-f]{6}$/i.test(dealer.themeColor)
      ? dealer.themeColor : "#B58A55",
  };
}
