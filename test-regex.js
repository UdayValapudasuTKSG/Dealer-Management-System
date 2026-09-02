const regex = /(?:([a-z0-9_-]+):"([^"]+)")|(?:([a-z0-9_-]+):([^\s]+))|(?:"([^"]+)")|([^\s]+)/gi;
const filterQuery = 'advisor:"John Doe" phase:"lead" source:website';
let match;
while ((match = regex.exec(filterQuery)) !== null) {
  const key = (match[1] || match[3])?.toLowerCase();
  const val = match[2] || match[4];
  console.log({key, val});
}
