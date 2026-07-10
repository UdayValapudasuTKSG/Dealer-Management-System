import { useListCustomers } from "@workspace/api-client-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Plus, User, MapPin, Car, Award } from "lucide-react";
import { Badge } from "@/components/ui/badge";

export default function Customers() {
  const { data: customers, isLoading } = useListCustomers();

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Customers</h1>
          <p className="text-muted-foreground">Manage customer relationships and loyalty</p>
        </div>
        <Button className="gap-2">
          <Plus className="w-4 h-4" />
          Add Customer
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
        {isLoading ? (
          [...Array(8)].map((_, i) => <div key={i} className="h-48 bg-muted rounded-xl animate-pulse" />)
        ) : (
          customers?.map((customer) => (
            <Card key={customer.id} className="hover-elevate transition-all border-border cursor-pointer">
              <CardContent className="p-6 flex flex-col h-full">
                <div className="flex items-start justify-between mb-4">
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-full bg-secondary flex items-center justify-center overflow-hidden">
                      {customer.avatarUrl ? (
                        <img src={customer.avatarUrl} alt={customer.name} className="w-full h-full object-cover" />
                      ) : (
                        <User className="w-6 h-6 text-muted-foreground" />
                      )}
                    </div>
                    <div>
                      <h3 className="font-bold text-lg leading-tight">{customer.name}</h3>
                      <div className="text-xs text-muted-foreground mt-1 flex items-center gap-1">
                        <MapPin className="w-3 h-3" />
                        {customer.location || "Unknown"}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="mt-auto pt-4 border-t border-border/50 grid grid-cols-2 gap-2 text-sm">
                  <div className="bg-secondary/50 rounded-lg p-2 flex flex-col items-center justify-center">
                    <Car className="w-4 h-4 text-muted-foreground mb-1" />
                    <span className="font-bold">{customer.vehiclesOwned}</span>
                  </div>
                  <div className="bg-secondary/50 rounded-lg p-2 flex flex-col items-center justify-center">
                    <Award className="w-4 h-4 text-primary mb-1" />
                    <span className="font-bold capitalize">{customer.loyaltyTier}</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}