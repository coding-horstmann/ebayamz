import FilterPanel, { type Filters } from "./components/FilterPanel";
import ProductTable from "./components/ProductTable";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type SearchParams = {
  minProfit?: string;
  minRoi?: string;
  maxBsr?: string;
  minSales?: string;
  buyingOption?: string;
};

export default function Page({ searchParams }: { searchParams: SearchParams }) {
  const filters: Filters = {
    minProfit: Number(searchParams.minProfit ?? 5),
    minRoi: Number(searchParams.minRoi ?? 50),
    maxBsr: Number(searchParams.maxBsr ?? 500000),
    minSales: Number(searchParams.minSales ?? 0),
    buyingOption:
      searchParams.buyingOption === "fixed" || searchParams.buyingOption === "auction"
        ? searchParams.buyingOption
        : "all",
  };

  return (
    <div className="space-y-6">
      <FilterPanel initial={filters} />
      <ProductTable filters={filters} />
    </div>
  );
}
