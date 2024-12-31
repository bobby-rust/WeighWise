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
} from "@shopify/polaris";
import { useLoaderData, Form, useNavigate, useSubmit } from "@remix-run/react";
import { TitleBar } from "@shopify/app-bridge-react";
import { useEffect, useState } from "react";

export const loader = async ({ params, request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const orderId = params.orderId;
  console.log(orderId);

  // Need variant price / weight variant for per lb price
  const query = `
    query getOrderDetails($id: ID!) {
      order(id: $id) {
        id
        name
        createdAt
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

  console.log("Order ID: ", orderId);
  console.log("Line Items: ", editedLineItems);
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
  console.log(
    "begin edit data response: ",
    beginEditData.data.orderEditBegin.calculatedOrder.lineItems,
  );
  const calculatedOrderId =
    beginEditData.data.orderEditBegin.calculatedOrder.id;

  for (const [id, lineItem] of editedLineItems) {
    const quantity = lineItem.quantity;
    if (!quantity) continue;
    const total = lineItem.total;
    const title = lineItem.title;
    console.log("Line item ID: ", lineItem.id);
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
    console.log("GOT BACK DATA FROM MUTATION: ", data);
    console.log(
      "calculatedLineItemId: ",
      data.data.orderEditAddCustomItem.calculatedOrder.addedLineItems
        .edges,
    );
    const calculatedLineItemId = lineItem.id.replace(
      "LineItem",
      "CalculatedLineItem",
    );
    console.log("Calculated line item ID: ", calculatedLineItemId);
    // const calculatedLineItemId =
    //   data.data.orderEditAddCustomItem.calculatedOrder.addedLineItems
    //     .edges;

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
    console.log("Remove item data: ", removeItemData);
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
  console.log("Commit edit response: ", commitEditData);
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
}

type LineItems = Map<string, LineItem>;

export default function OrderDetails() {
  const loaderData = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const navigate = useNavigate();

  useEffect(() => {
    const lineItems: LineItems = new Map<string, LineItem>();
    loaderData.order.lineItems.nodes.forEach((item: any) => {
      console.log(item);
      if (item.refundableQuantity < 1) return;
      let pricePerLb = item.variant?.price;
      let finalWeight = "";
      if (item.variant) {
        const variant: any = item.variant;
        console.log("Variant: ", variant);
        variant.selectedOptions.forEach((opt: any) => {
          console.log("OPT: ", opt);
          if (opt.name.trim().toLowerCase() == "weight") {
            let lbs =
              parseInt(
                opt.optionValue.name
                  .trim()
                  .toLowerCase()
                  .replace("lb", ""),
              ) || 1;
            pricePerLb = (variant.price / lbs).toFixed(2);
            finalWeight = lbs.toFixed(2);
          }
        });
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
          parseFloat(item.variant?.price)
        ).toFixed(2),
      };
      lineItems.set(item.id, curItem);
    });

    setLineItems(lineItems);
  }, [loaderData.order]);

  const [lineItems, setLineItems] = useState<LineItems>(
    new Map<string, LineItem>(),
  ); // State for edited line items

  const handleCancel = () => {
    console.log("Cancelling");
    navigate("/app");
  };

  const handlePriceChange = (id: string, value: string) => {
    const decimalRegex = /^\d*\.?\d*$/;
    if (!decimalRegex.test(value)) return;
    console.log("Price changed");
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

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    console.log("Form submitting.");
    console.log(lineItems);
    const formData = new FormData();
    formData.append(
      "editedLineItems",
      JSON.stringify(Array.from(lineItems.entries())),
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
    // console.log(newLineItem);
    setLineItems(newLineItems);
  };

  const columns = [
    "Image",
    "Order Name",
    "Created At",
    "Item",
    "Quantity",
    "Price Per Lb",
    "Final Weight (lb)",
    "Total",
  ];

  // Rows for DataTable
  const rows: TableData[][] = [];
  lineItems.forEach((item: LineItem, id: string) => {
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
        <img alt="placeholder" src={""} />
      ),
      loaderData.order.name,
      new Date(loaderData.order.createdAt).toLocaleString(),
      item.title,
      item.quantity,
      <TextField
        label=""
        autoSize
        key={item.id}
        type="text"
        value={item.pricePerLb}
        onChange={(value) => handlePriceChange(item.id, value)}
        // pattern="^[0-9]{0,7}\.[0-9]{1,9}$"
        autoComplete="off"
      />,
      <TextField
        label=""
        autoSize
        key={item.id}
        type="text"
        value={item.finalWeight}
        onChange={(value) => handleWeightChange(item.id, value)}
        // pattern="^[0-9]{0,7}\.[0-9]{1,9}$"
        autoComplete="off"
      />,
      `$${item.total}`,
    ]);
  });

  return (
    <Page>
      <TitleBar title={`Order ${loaderData.order.name}`} />
      <Card>
        <Form method="POST">
          <DataTable
            columnContentTypes={[
              "text",
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
    </Page>
  );
}
