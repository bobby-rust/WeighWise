import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import type { TableData } from "@shopify/polaris";
import {
  Button,
  Card,
  DataTable,
  Page,
  TextField,
  InlineStack,
  Text,
  BlockStack,
} from "@shopify/polaris";
import { useLoaderData, Form, useNavigate, useSubmit } from "@remix-run/react";
import { TitleBar } from "@shopify/app-bridge-react";
import { useEffect, useRef, useState } from "react";

export const loader = async ({ params, request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const orderId = params.orderId;

  // Need variant price / weight variant for per lb price
  const query = `
    query getOrderDetails($id: ID!) {
      order(id: $id) {
        id
        name
        createdAt
        customer {
          firstName
          lastName
          email
        }
        discountApplications (first:50) {
      		nodes {
            allocationMethod
            targetSelection
            targetType
            value {
              __typename
              ... on MoneyV2 {
                amount
              }
              ... on PricingPercentageValue {
                percentage
              }
            }
          }
    		}
        subtotalPriceSet {
          presentmentMoney {
            amount
          }
        }
        totalPriceSet {
          presentmentMoney {
            amount
          }
        }
        lineItems(first: 250) {
          nodes {
            id
            title
            refundableQuantity
            image {
              url
            }
            variant {
              id
              displayName
              price
              selectedOptions {
                name
                optionValue {
                  name
                }
                value
              }
            }
            discountedUnitPriceSet {
              presentmentMoney {
                amount
              }
            }
          }
        }
      }
    }`;

  const response = await admin.graphql(query, {
    variables: {
      id: `gid://shopify/Order/${orderId}`,
    },
  });
  const orderDetails = await response.json();
  return {
    order: orderDetails.data.order,
  };
}; // Adjust path to your Shopify Admin client

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const ctx = await authenticate.admin(request);
  const { admin, redirect } = ctx;
  const orderId = params.orderId; // Assuming orderId comes from params
  if (!orderId) return;

  const formData = await request.formData();
  // This is [[string id, LineItem lineItem], [string id, LineItem lineItem]...]
  const editedLineItems = JSON.parse(
    (formData.get("editedLineItems") as string) || "{}",
  );

  // so for each line item, create a custom line item with its properties and remove the line item with the id
  const mutationBeginEdit = `
    mutation beginEdit {
      orderEditBegin(id: "gid://shopify/Order/${orderId}"){
        calculatedOrder{
          id
          lineItems (first: 50) {
            nodes {
              id
            }
          }
        }
        userErrors {
          field
          message
        }
      }
    }`;

  const beginEditResponse = await admin.graphql(mutationBeginEdit);
  const beginEditData = await beginEditResponse.json();

  const calculatedOrderId =
    beginEditData.data.orderEditBegin.calculatedOrder.id;

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for (const [_, lineItem] of editedLineItems) {
    const quantity = lineItem.quantity;
    if (!quantity) continue;
    const total = lineItem.total;
    const title = lineItem.title;
    const mutation = `
    mutation addCustomItemToOrder {
      orderEditAddCustomItem(id: "${calculatedOrderId}", title: "${title} ${parseFloat(lineItem.finalWeight).toFixed(2)}lb @ $${lineItem.pricePerLb}/lb", quantity: 1, price: { amount: ${total}, currencyCode: USD }) {
        calculatedOrder {
          id
          addedLineItems(first: 50) {
            edges {
              node {
                id
              }
            }
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

    const response = await admin.graphql(mutation);
    const data = await response.json();

    if (data.data?.userErrors) return;

    const calculatedLineItemId = lineItem.id.replace(
      "LineItem",
      "CalculatedLineItem",
    );

    const removeItemMutation = `
      mutation removeLineItem {
        orderEditSetQuantity(id: "${calculatedOrderId}", lineItemId: "${calculatedLineItemId}", quantity: 0) {
          calculatedOrder {
            id
            lineItems(first: 5) {
              edges {
                node {
                  id
                  quantity
                }
              }
            }
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const removeItemResponse = await admin.graphql(removeItemMutation);
    const removeItemData = await removeItemResponse.json();
    if (removeItemData.data?.userErrors) return;
  }
  const commitEditMutation = `
    mutation commitEdit {
      orderEditCommit(id: "${calculatedOrderId}", notifyCustomer: false, staffNote: "I edited the order! It was me!") {
        order {
          id
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const commitEditResponse = await admin.graphql(commitEditMutation);
  const commitEditData = await commitEditResponse.json();
  if (commitEditData.data?.userErrors) return;

  const shopUrl = ctx.session.shop;
  const shopifyOrderUrl = `https://${shopUrl}/admin/orders/${orderId}`;
  return redirect(shopifyOrderUrl, { target: "_parent" });
};

interface LineItem {
  id: string;
  image: string;
  title: string;
  quantity: string;
  // variant: {
  //   selectedOptions: {
  //     name: string;
  //     optionValue: {
  //       name: string;
  //     };
  //   };
  // };
  pricePerLb: string;
  finalWeight: string;
  total: string;
  [key: string]: string;
}

type LineItems = Map<string, LineItem>;

export default function OrderDetails() {
  const loaderData = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const navigate = useNavigate();
  const uneditedLineItemsRef = useRef<LineItems | null>(null);

  useEffect(() => {
    const lineItems: LineItems = new Map<string, LineItem>();
    loaderData.order.lineItems.nodes.forEach((item: any) => {
      if (item.refundableQuantity < 1) return;
      let pricePerLb =
        item.variant?.price ||
        item.discountedUnitPriceSet.presentmentMoney.amount;
      let finalWeight = "1.00"; // when in doubt, 1lb it out
      if (item.variant) {
        const variant: any = item.variant;
        variant.selectedOptions.forEach((opt: any) => {
          if (opt.name.trim().toLowerCase() == "weight") {
            let lbs =
              parseInt(
                opt.optionValue.name
                  .trim()
                  .toLowerCase()
                  .replace("lb", ""),
              ) || 1;
            pricePerLb = (variant.price / lbs).toFixed(2);
            finalWeight = (lbs * item.refundableQuantity).toFixed(
              2,
            );
          }
        });
      } else {
        // If it doesn't have a variant, must it be a custom item added by this app?
        // Let's assume so for now
        // Parse the price per lb and final weight from the item's title
        const title = item.title;
        pricePerLb = parseFloat(
          title.split("$")[1].split("/lb")[0],
        ).toFixed(2);
        const extractWeightRegex = /\b(\d+\.\d+)(?=lb)/;
        const wt = title.match(extractWeightRegex);
        finalWeight = wt ? parseFloat(wt[1]).toFixed(2) : "1.00";
      }
      const curItem: LineItem = {
        id: item.id,
        image: item.image?.url,
        title:
          item.variant?.displayName.replace(" - Default Title", "") ||
          item.title,
        quantity: item.refundableQuantity,
        pricePerLb: pricePerLb,
        finalWeight: finalWeight,
        total: (
          parseFloat(item.refundableQuantity) *
          parseFloat(
            item.variant?.price ||
            item.discountedUnitPriceSet.presentmentMoney.amount,
          )
        ).toFixed(2),
      };
      lineItems.set(item.id, curItem);
    });

    uneditedLineItemsRef.current = lineItems;
    setLineItems(lineItems);
  }, [loaderData.order]);

  const [lineItems, setLineItems] = useState<LineItems>(
    new Map<string, LineItem>(),
  ); // State for edited line items

  const handleCancel = () => {
    navigate("/app");
  };

  const handlePriceChange = (id: string, value: string) => {
    const decimalRegex = /^\d*\.?\d*$/;
    if (!decimalRegex.test(value)) return;
    const newLineItems = structuredClone(lineItems);
    const newLineItem = newLineItems.get(id);

    if (!newLineItem) return;

    newLineItem.pricePerLb = value;

    let newTotal =
      parseFloat(newLineItem.pricePerLb) *
      parseFloat(newLineItem.finalWeight);

    if (isNaN(newTotal)) newTotal = 0;
    newLineItem.total = newTotal.toFixed(2);
    newLineItems.set(id, newLineItem);
    setLineItems(newLineItems);
  };

  // If the price doesn't change, we probably don't want to edit the line item
  function compareLineItem(i1: LineItem, i2: LineItem) {
    return i1.total === i2.total;
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!uneditedLineItemsRef.current) return;
    const editedLineItems: LineItems = new Map<string, LineItem>();
    for (const lineItem of lineItems) {
      const id = lineItem[0];
      const item = lineItem[1];

      const uneditedLineItem = uneditedLineItemsRef.current.get(id);
      if (!uneditedLineItem) continue;

      if (!compareLineItem(uneditedLineItem, item)) {
        editedLineItems.set(id, item);
      }
    }

    if (!editedLineItems.size) {
      alert("No changes were made");
      navigate("/app");
      return;
    }

    const formData = new FormData();
    formData.append(
      "editedLineItems",
      JSON.stringify(Array.from(editedLineItems.entries())),
    );

    submit(formData, { method: "POST" });
  };

  const handleWeightChange = (id: string, value: string) => {
    const decimalRegex = /^\d*\.?\d*$/;
    if (!decimalRegex.test(value)) return;

    const newLineItems = structuredClone(lineItems);
    const newLineItem = newLineItems.get(id);
    if (!newLineItem) return;

    newLineItem.finalWeight = value;
    let newTotal =
      parseFloat(newLineItem.pricePerLb) *
      parseFloat(newLineItem.finalWeight);

    if (isNaN(newTotal)) {
      newTotal = 0;
    }
    newLineItem.total = newTotal.toFixed(2);
    newLineItems.set(id, newLineItem);
    setLineItems(newLineItems);
  };

  const columns = [
    "Image",
    "Order Name",
    "Created At",
    "Item",
    "Quantity",
    "Price Per Lb/Unit",
    "Final Weight (lb)",
    "Total",
  ];

  // Rows for DataTable
  const rows: TableData[][] = [];
  lineItems.forEach((item: LineItem, _: string) => {
    rows.push([
      item.image ? (
        <div style={{ width: "3rem", textAlign: "center" }}>
          <img
            alt="item"
            src={item.image}
            style={{
              height: "3rem",
              width: "3rem",
              objectFit: "contain",
            }}
          />
        </div>
      ) : (
        <img
          alt="placeholder"
          style={{ height: "3rem", width: "3rem" }}
          src={
            "https://cdn.shopify.com/s/files/1/0734/7372/0540/files/placeholder-image.jpg?v=1735620821"
          }
        />
      ),
      loaderData.order.name,
      new Date(loaderData.order.createdAt).toLocaleString(),
      item.title,
      item.quantity,
      item.title.toLowerCase().includes("box") ||
        item.title.toLowerCase().includes("snack sticks") ||
        item.title.toLowerCase().includes("honey") ||
        item.title.toLowerCase().includes("half beef (") ||
        item.title.toLowerCase().includes("whole beef (") ||
        item.title.toLowerCase().includes("half pork (") ||
        item.title.toLowerCase().includes("whole pork (") ? (
        "$" + item.pricePerLb
      ) : (
        <TextField
          label=""
          autoSize
          key={item.id}
          type="text"
          value={item.pricePerLb}
          onChange={(value) => handlePriceChange(item.id, value)}
          // pattern="^[0-9]{0,7}\.[0-9]{1,9}$"
          autoComplete="off"
        />
      ),
      item.title.toLowerCase().includes("box") ||
        item.title.toLowerCase().includes("snack sticks") ||
        item.title.toLowerCase().includes("honey") ||
        item.title.toLowerCase().includes("half beef (") ||
        item.title.toLowerCase().includes("whole beef (") ||
        item.title.toLowerCase().includes("half pork (") ||
        item.title.toLowerCase().includes("whole pork (") ? (
        "N/A"
      ) : (
        <TextField
          label=""
          autoSize
          key={item.id}
          type="text"
          value={item.finalWeight}
          onChange={(value) => handleWeightChange(item.id, value)}
          // pattern="^[0-9]{0,7}\.[0-9]{1,9}$"
          autoComplete="off"
        />
      ),
      `$${item.total}`,
    ]);
  });

  return (
    <Page>
      <TitleBar title={`Order ${loaderData.order.name}`} />
      <BlockStack gap="500">
        <Card>
          <InlineStack gap="400">
            <Text as="h2" variant="headingMd">
              {loaderData.order.customer.firstName || "Guest"}{" "}
              {loaderData.order.customer.lastName || "Guest"}
            </Text>
            <Text as="h2" variant="headingMd">
              {loaderData.order.customer.email || ""}
            </Text>
          </InlineStack>
        </Card>
        <Card>
          {/* Header Section */}
          <InlineStack
            align="space-between"
            blockAlign="center"
            gap="200"
          >
            <Text as="h2" variant="headingMd">
              {loaderData.order.name}
            </Text>
            <Text as="h2" variant="headingMd">
              {new Date(
                loaderData.order.createdAt,
              ).toLocaleString()}
            </Text>
          </InlineStack>
          <Form method="POST">
            <DataTable
              columnContentTypes={[
                "text",
                "text",
                "text",
                "text",
                "text",
                "text",
              ]}
              headings={columns.filter(
                (col) =>
                  col !== "Order Name" &&
                  col !== "Created At",
              )}
              rows={rows.map((row) =>
                row.filter(
                  (_, index) => index !== 1 && index !== 2,
                ),
              )} // Remove first two columns (Order Name, Created At)
              verticalAlign="middle"
            />
            {/* Hidden input to submit the edited line items */}
            <input
              type="hidden"
              name="editedLineItems"
              value={JSON.stringify(lineItems)}
            />
            {/* Save Button */}
            <InlineStack align="end" blockAlign="center" gap="200">
              <Button variant="secondary" onClick={handleCancel}>
                Cancel
              </Button>
              <Button
                variant="primary"
                onClick={handleSubmit as () => unknown}
              >
                Save Edits
              </Button>
            </InlineStack>
          </Form>
        </Card>
      </BlockStack>
    </Page>
  );
}
