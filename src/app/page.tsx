import FilterPanel from "./components/FilterPanel";
import ProductTable from "./components/ProductTable";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type SearchParams = {
  minProfit?: string;
  minRoi?: string;
  maxBsr?: string;
  minSales?: string;
};

export default function Page({ searchParams }: { searchParams: SearchParams }) {
  const filters = {
    minProfit: Number(searchParams.minProfit ?? 5),
    minRoi: Number(searchParams.minRoi ?? 50),
    maxBsr: Number(searchParams.maxBsr ?? 500000),
    minSales: Number(searchParams.minSales ?? 0),
  };

  return (
    <div className="space-y-6">
      <FilterPanel initial={filters} />
      <ProductTable filters={filters} />
    </div>
  );
}
