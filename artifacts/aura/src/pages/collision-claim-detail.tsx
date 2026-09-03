import { Link, useRoute } from "wouter";
import { ArrowLeft } from "lucide-react";
import { ClaimDetail } from "@/components/collision-claims";
import { Page } from "@/components/layout/page";
import { Button } from "@/components/ui/button";

export default function CollisionClaimDetailPage() {
  const [, params] = useRoute("/service/collision/:id");
  const claimId = params ? Number(params.id) : NaN;

  if (!Number.isInteger(claimId) || claimId <= 0) {
    return (
      <Page>
        <div className="py-24 text-center text-muted-foreground">
          Invalid collision claim.
        </div>
      </Page>
    );
  }

  return (
    <Page>
      <Button asChild variant="ghost" className="mb-4 -ml-3 text-muted-foreground hover:text-foreground">
        <Link href="/service?tab=collision">
          <ArrowLeft className="w-4 h-4 mr-2" />
          Back to collision claims
        </Link>
      </Button>
      <div className="overflow-hidden rounded-2xl border border-border/60 bg-background shadow-sm">
        <ClaimDetail claimId={claimId} />
      </div>
    </Page>
  );
}