import { Link, useLocation } from "wouter";
import {
  useListCustomers,
  useCreateCustomer,
  getListCustomersQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Plus, User, MapPin, Car, Mail, Phone, Crown, Building2 } from "lucide-react";
import { motion } from "framer-motion";
import { Page } from "@/components/layout/page";
import { PageHero } from "@/components/layout/page-hero";
import { CreateRecordDialog } from "@/components/create-record-dialog";
import { useToast } from "@/hooks/use-toast";
import { useViewMode } from "@/hooks/use-view-mode";
import { ViewControls } from "@/components/view-controls";

const TypeBadge = ({ type }: { type?: string }) =>
  type === "business" ? (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider bg-gold/15 text-gold shrink-0">
      <Building2 className="w-3 h-3" />
      Business
    </span>
  ) : null;

const tierColor = (tier: string) => {
  switch (tier) {
    case "platinum":
      return "text-gold bg-gold/10";
    case "gold":
      return "text-amber-500 bg-amber-500/10";
    case "silver":
      return "text-slate-400 bg-slate-400/10";
    default:
      return "text-muted-foreground bg-white/[0.05]";
  }
};

export default function Customers() {
  const { data: customers, isLoading } = useListCustomers();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const createCustomer = useCreateCustomer();
  const { density, setDensity, layout, setLayout } = useViewMode("customers");
  const [, navigate] = useLocation();

  const comfortable = density === "comfortable";

  return (
    <>
    <PageHero

      eyebrow="Relationships"
      title="Account"
      accent="Portfolio"
      subtitle="Lifetime relationships and loyalty."
    />
    <Page className="space-y-5">
      <div className="flex items-center justify-end gap-3">
            <ViewControls
              layout={layout}
              onLayoutChange={setLayout}
              density={density}
              onDensityChange={setDensity}
            />
            <CreateRecordDialog
              title="Add Account"
              description="Create a new relationship in the portfolio."
              pending={createCustomer.isPending}
              submitLabel="Add Account"
              trigger={
                <Button className="bg-primary hover:bg-primary/90 text-white rounded-full px-6 h-12 shadow-lg shadow-primary/20 gap-2 font-medium tracking-wide">
                  <Plus className="w-5 h-5" />
                  Add Account
                </Button>
              }
              fields={[
                { name: "name", label: "Full name", type: "text", required: true, span: "full", placeholder: "Jane Mensah" },
                {
                  name: "accountType",
                  label: "Account type",
                  type: "select",
                  span: "half",
                  defaultValue: "person",
                  options: [
                    { value: "person", label: "Person" },
                    { value: "business", label: "Business" },
                  ],
                },
                { name: "email", label: "Email", type: "text", span: "half", placeholder: "jane@email.com" },
                { name: "phone", label: "Phone", type: "text", span: "half", placeholder: "+233 …" },
                { name: "whatsapp", label: "WhatsApp", type: "text", span: "half", placeholder: "+233 …" },
                { name: "dateOfBirth", label: "Date of birth", type: "date", span: "half" },
                { name: "occupation", label: "Occupation", type: "text", span: "half", placeholder: "Executive" },
                { name: "company", label: "Company", type: "text", span: "half", placeholder: "Acme Ltd" },
                { name: "city", label: "City", type: "text", span: "half", placeholder: "Accra" },
                { name: "country", label: "Country", type: "text", span: "half", placeholder: "Ghana" },
                { name: "location", label: "Location", type: "text", span: "half", placeholder: "Accra" },
                {
                  name: "loyaltyTier",
                  label: "Loyalty tier",
                  type: "select",
                  span: "half",
                  defaultValue: "new",
                  options: [
                    { value: "new", label: "New" },
                    { value: "silver", label: "Silver" },
                    { value: "gold", label: "Gold" },
                    { value: "platinum", label: "Platinum" },
                  ],
                },
              ]}
              onSubmit={async (values) => {
                await createCustomer.mutateAsync({ data: values as never });
                queryClient.invalidateQueries({ queryKey: getListCustomersQueryKey() });
                toast({ title: "Account added", description: "AURA is enriching the new profile." });
              }}
            />
      </div>

      {isLoading ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {[...Array(8)].map((_, i) => (
            <div key={i} className="h-40 bg-white/[0.05] rounded-2xl animate-pulse" />
          ))}
        </div>
      ) : layout === "list" ? (
        <div className="glass-panel rounded-2xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 text-left text-xs uppercase tracking-wider text-muted-foreground">
                <th className="px-4 py-3 font-semibold">Account</th>
                <th className="px-4 py-3 font-semibold">Tier</th>
                <th className="px-4 py-3 font-semibold text-right">LTV</th>
                <th className="px-4 py-3 font-semibold text-right">Vehicles</th>
                <th className="px-4 py-3 font-semibold">Contact</th>
              </tr>
            </thead>
            <tbody>
              {customers?.map((customer) => (
                <tr
                  key={customer.id}
                  onClick={() => navigate(`/customers/${customer.id}`)}
                  className="border-b border-white/5 last:border-0 cursor-pointer hover:bg-foreground/[0.04] transition-colors h-12"
                >
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-8 h-8 rounded-full bg-white/[0.06] border border-white/10 flex items-center justify-center overflow-hidden shrink-0">
                        {customer.avatarUrl ? (
                          <img src={customer.avatarUrl} alt={customer.name} className="w-full h-full object-cover" />
                        ) : (
                          <User className="w-4 h-4 text-muted-foreground/40" />
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="font-medium truncate flex items-center gap-2">
                          {customer.name}
                          <TypeBadge type={customer.accountType} />
                        </div>
                        <div className="text-xs text-muted-foreground truncate">
                          {customer.location || "Location unknown"}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-2">
                    <span
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold uppercase tracking-wider ${tierColor(customer.loyaltyTier)}`}
                    >
                      <Crown className="w-3 h-3" />
                      {customer.loyaltyTier}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums font-medium text-primary">
                    ${(customer.lifetimeValue / 1000).toFixed(1)}k
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">{customer.vehiclesOwned}</td>
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2 text-muted-foreground">
                      {customer.email && (
                        <span className="inline-flex items-center gap-1 text-xs truncate max-w-[180px]">
                          <Mail className="w-3.5 h-3.5 shrink-0" />
                          {customer.email}
                        </span>
                      )}
                      {customer.phone && (
                        <span className="inline-flex items-center gap-1 text-xs">
                          <Phone className="w-3.5 h-3.5 shrink-0" />
                          {customer.phone}
                        </span>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : comfortable ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
          {customers?.map((customer, i) => (
            <motion.div
              key={customer.id}
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: Math.min(i * 0.04, 0.4) }}
            >
              <Link href={`/customers/${customer.id}`} className="block h-full">
                <Card className="glass-panel border-none shadow-sm hover:shadow-xl transition-all duration-300 cursor-pointer rounded-3xl group overflow-hidden h-full flex flex-col">
                  <CardContent className="p-0 flex flex-col h-full">
                    <div className="p-6 bg-gradient-to-b from-black/5 to-transparent relative border-b border-border/40">
                      <div className="absolute top-4 right-4 flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold uppercase tracking-widest backdrop-blur-md bg-white/[0.05]">
                        <Crown className={`w-3.5 h-3.5 ${tierColor(customer.loyaltyTier).split(" ")[0]}`} />
                        <span className={tierColor(customer.loyaltyTier).split(" ")[0]}>{customer.loyaltyTier}</span>
                      </div>
                      <div className="w-20 h-20 rounded-full bg-white/[0.06] shadow-md flex items-center justify-center overflow-hidden mb-4 border-2 border-white/10 group-hover:border-primary transition-colors duration-300">
                        {customer.avatarUrl ? (
                          <img src={customer.avatarUrl} alt={customer.name} className="w-full h-full object-cover" />
                        ) : (
                          <User className="w-10 h-10 text-muted-foreground/30" />
                        )}
                      </div>
                      <h3 className="font-bold text-2xl leading-tight mb-1 group-hover:text-primary transition-colors flex items-center gap-2 flex-wrap">
                        {customer.name}
                        <TypeBadge type={customer.accountType} />
                      </h3>
                      <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                        <MapPin className="w-3.5 h-3.5" />
                        {customer.location || "Location Unknown"}
                      </div>
                    </div>
                    <div className="p-6 flex-1 flex flex-col justify-between">
                      <div className="space-y-3 mb-6 text-sm font-medium text-muted-foreground">
                        {customer.email && (
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 rounded-full bg-white/[0.05] flex items-center justify-center text-foreground shrink-0">
                              <Mail className="w-4 h-4" />
                            </div>
                            <span className="truncate">{customer.email}</span>
                          </div>
                        )}
                        {customer.phone && (
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 rounded-full bg-white/[0.05] flex items-center justify-center text-foreground shrink-0">
                              <Phone className="w-4 h-4" />
                            </div>
                            <span>{customer.phone}</span>
                          </div>
                        )}
                      </div>
                      <div className="grid grid-cols-2 gap-4 pt-4 border-t border-border/50">
                        <div>
                          <div className="text-xs font-semibold tracking-widest text-muted-foreground uppercase mb-1">LTV</div>
                          <div className="font-light text-xl tracking-tight text-primary">
                            ${(customer.lifetimeValue / 1000).toFixed(1)}k
                          </div>
                        </div>
                        <div>
                          <div className="text-xs font-semibold tracking-widest text-muted-foreground uppercase mb-1 flex items-center gap-1.5">
                            <Car className="w-3.5 h-3.5" /> Owned
                          </div>
                          <div className="font-light text-xl tracking-tight">
                            {customer.vehiclesOwned}{" "}
                            <span className="text-sm font-medium uppercase tracking-widest text-muted-foreground">Vehicles</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            </motion.div>
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-5 gap-4">
          {customers?.map((customer, i) => (
            <motion.div
              key={customer.id}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: Math.min(i * 0.03, 0.3) }}
            >
              <Link href={`/customers/${customer.id}`} className="block h-full">
                <Card className="glass-panel border-none shadow-sm hover:shadow-lg transition-all duration-200 cursor-pointer rounded-2xl group h-full">
                  <CardContent className="p-4 flex flex-col gap-3">
                    <div className="flex items-start gap-3">
                      <div className="w-10 h-10 rounded-full bg-white/[0.06] border border-white/10 flex items-center justify-center overflow-hidden shrink-0 group-hover:border-primary transition-colors">
                        {customer.avatarUrl ? (
                          <img src={customer.avatarUrl} alt={customer.name} className="w-full h-full object-cover" />
                        ) : (
                          <User className="w-5 h-5 text-muted-foreground/40" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="font-semibold text-base leading-tight truncate group-hover:text-primary transition-colors flex items-center gap-1.5">
                          <span className="truncate">{customer.name}</span>
                          <TypeBadge type={customer.accountType} />
                        </div>
                        <div className="text-xs text-muted-foreground truncate flex items-center gap-1">
                          <MapPin className="w-3 h-3 shrink-0" />
                          {customer.location || "Location unknown"}
                        </div>
                      </div>
                      <span
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider shrink-0 ${tierColor(customer.loyaltyTier)}`}
                      >
                        <Crown className="w-3 h-3" />
                        {customer.loyaltyTier}
                      </span>
                    </div>
                    <div className="space-y-1 text-xs text-muted-foreground min-h-[2rem]">
                      {customer.email && (
                        <div className="flex items-center gap-1.5 truncate">
                          <Mail className="w-3.5 h-3.5 shrink-0" />
                          <span className="truncate">{customer.email}</span>
                        </div>
                      )}
                      {customer.phone && (
                        <div className="flex items-center gap-1.5">
                          <Phone className="w-3.5 h-3.5 shrink-0" />
                          <span>{customer.phone}</span>
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-2 pt-2 border-t border-border/50">
                      <span className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-white/[0.04] text-xs">
                        <span className="text-muted-foreground uppercase tracking-wider text-[10px] font-semibold">LTV</span>
                        <span className="tabular-nums font-medium text-primary">
                          ${(customer.lifetimeValue / 1000).toFixed(1)}k
                        </span>
                      </span>
                      <span className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-white/[0.04] text-xs">
                        <Car className="w-3.5 h-3.5 text-muted-foreground" />
                        <span className="tabular-nums font-medium">{customer.vehiclesOwned}</span>
                      </span>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            </motion.div>
          ))}
        </div>
      )}
    </Page>
    </>
  );
}
