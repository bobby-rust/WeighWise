import { Page, Card, DataTable, Button, Text } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { TitleBar } from "@shopify/app-bridge-react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData, useNavigate } from "@remix-run/react";

// Don't show orders containing ONLY these products,
// as these are not adjustable products
const blacklistedProductsJson = {
  customCutBeef: ["7118485389448", "8853497118940"], // TWO FOR TESTING, SECOND ONE IS DEV STORE ID
  customCutPork: ["8423825997960"],
  csa: ["7118232944776"],
  honey: ["8427705958536", "8427707465864"], // regular & cream
  summerSausage: ["7112410333320"],
  mapleSyrup: ["8427704778888"],
  beefSnackSticks: ["7112411218056"],
  beefJerky: ["7112411414664"],
  beefBoxes: [
    { oneSixteenth: "7118219772040" },
    { effortless: "7118217707656" },
    { oneEighth: "7118218068104" },
    { ohMy: "7118215708808" },
    { pintSize: "7118217183368" },
    { oneQuarter: "7118219018376" },
    { straddlingTheFence: "7118218363016" },
  ],
  porkBoxes: [
    { pocketSizedPiglet: "7118226587784" },
    { picnic: "7920674242696" },
    { oneQuarter: "7118227013768" },
    { oneEighth: "7118226849928" },
    { thePortlyPig: "7118226456712" },
  ],
  hybridBoxes: [
    { betwixtAndBetween: "7118222327944" },
    { theHybrid: "7118221672584" },
    { everythingButTheKitchenSink: "7118212661384" },
  ],
};

const blacklistedIds: any = [];
for (const [key, value] of Object.entries(blacklistedProductsJson)) {
  console.log("Key: ", key);
  console.log("Value: ", value);
  if (key.includes("Box")) {
    for (let i = 0; i < value.length; ++i) {
      blacklistedIds.push(...Object.values(value[i]));
    }
  } else {
    blacklistedIds.push(...value);
  }
}

console.log("BLACKLISTED IDS: ", blacklistedIds);

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const query = `
    query getOrders {
      orders(first: 250, query: "fulfillment_status:unfulfilled AND NOT financial_status:expired AND NOT financial_status:voided") {
        edges {
          node {
            id
            name
            createdAt
            cartDiscountAmountSet {
              presentmentMoney {
                amount
              }
            }
            currentSubtotalPriceSet {
              presentmentMoney {
                amount
              }
            }
            customer {
              firstName
              lastName
              email
            }
            lineItems(first: 250) {
              edges {
                node {
                  id
                  title
                  quantity
                  product {
                    id
                  }
                  variant {
                    displayName
                  }
                  discountedUnitPriceSet {
                    presentmentMoney {
                      amount
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  `;

  const response = await admin.graphql(query);
  const ordersData = await response.json();
  console.log("Orders data: ", ordersData.data);
  const orders = ordersData.data.orders.edges.map((order: any) => {
    const orderSubtotal = parseFloat(
      order.node.currentSubtotalPriceSet.presentmentMoney.amount,
    );

    if (orderSubtotal === 0) return null;

    const lineItems = order.node.lineItems.edges;
    let hasAdjustableItem = false;
    const blacklistedIdsSet = new Set(blacklistedIds);
    for (let i = 0; i < lineItems.length; i++) {
      const currentProduct = lineItems[i].node?.product;
      if (!currentProduct) continue; // honestly idk why this would ever happen but i dont want code crashing
      const productIdArr = currentProduct.id?.split("/");
      const productId = productIdArr[productIdArr.length - 1];
      // If it has an item that isn't blacklisted, it's an adjustable order
      if (!blacklistedIdsSet.has(productId)) {
        hasAdjustableItem = true;
      }
    }

    if (!hasAdjustableItem) return null;

    // const orderDiscount = parseFloat(
    //   order.node.cartDiscountAmountSet?.presentmentMoney.amount,
    // );

    let subtotal = orderSubtotal;
    // if (!isNaN(orderDiscount)) {
    //   // The subtotal is after discounts applied, un-apply the discount for clarity
    //   subtotal += orderDiscount;
    // }

    return {
      id: order.node.id,
      name: order.node.name || "Guest",
      created: order.node.createdAt,
      subtotal: subtotal,
      customer: `${order.node.customer?.firstName || "Guest"} ${order.node.customer?.lastName || ""}`,
      email: order.node.customer?.email || "N/A",
      items: order.node.lineItems.edges.map((lineItem: any) => ({
        title:
          lineItem.node.variant?.displayName || lineItem.node.title,
        quantity: lineItem.node.quantity,
        price: lineItem.node.discountedUnitPriceSet.presentmentMoney
          .amount,
      })),
    };
  });

  return orders;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
};

export default function Index() {
  let orders = useLoaderData<typeof loader>();
  orders = orders.filter((order: any) => order !== null);

  const navigate = useNavigate();

  const rows = orders.map((order: any) => {
    let title = order.items[0].title.replace(" - Default Title", "");
    let perLbOrBox = "/lb";
    if (title.toLowerCase().includes("box")) {
      perLbOrBox = "/box";
    }
    return [
      order.name,
      order.customer,
      order.email,
      new Date(order.created).toLocaleString(),
      `${order.items[0].quantity} x ${title} @ $${parseFloat(order.items[0].price).toFixed(2)}${perLbOrBox}`,
      `$${parseFloat(order.subtotal).toFixed(2)}`,
      <Button
        variant="primary"
        key={order.id + order.email}
        onClick={() => {
          navigate(
            `/app/orders/${order.id.replace("gid://shopify/Order/", "")}`,
          );
        }}
      >
        Edit Order
      </Button>,
    ];
  });

  const columns = [
    "Order",
    "Customer",
    "Email",
    "Created At",
    "First Item",
    "Subtotal",
    "Edit Order",
  ];
  return (
    <Page fullWidth>
      <TitleBar title="Unfulfilled Orders" />
      {rows.length ? (
        <Card>
          <DataTable
            columnContentTypes={[
              "text",
              "text",
              "text",
              "text",
              "text",
              "text",
              "text",
            ]}
            headings={columns}
            rows={rows}
          />
        </Card>
      ) : (
        <Text variant="heading2xl" as="h1" alignment="center">
          No Unfulfilled Orders
        </Text>
      )}
    </Page>
  );
}
