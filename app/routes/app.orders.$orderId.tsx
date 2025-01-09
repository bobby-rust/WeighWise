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
  Spinner,
} from "@shopify/polaris";
import { useLoaderData, Form, useNavigate, useSubmit } from "@remix-run/react";
import { useEffect, useRef, useState } from "react";

export const loader = async ({ params, request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);

  const orderId = params.orderId;

  console.log("Viewing Order ID: ", orderId);

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
            ... on ManualDiscountApplication {
              title
              description
            }
            ... on DiscountCodeApplication {
              code
            }
            ... on ScriptDiscountApplication {
              title
            }
            ... on AutomaticDiscountApplication {
              title
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
  console.log(orderDetails.data.order.lineItems);
  console.log(
    "Order details query discount data: ",
    orderDetails.data?.order.discountApplications,
  );
  console.log(
    "Order details query discount data: ",
    orderDetails.data?.order.discountApplications.nodes[0]?.value,
  );
  return {
    order: orderDetails.data.order,
    discounts: orderDetails.data.order.discountApplications.nodes,
  };
};

/**
 * Adds a custom line item to an order to make up the price difference
 * between the expected weight of an item and the actual weight
 *
 * @param priceDifference the absolute value of the original item price
 * minus the actual item price
 * @param customItemName the name to give to the custom item that is added to the order
 * @param calculatedOrderId the calculated order id
 * @param admin the GraphQL client context
 */
async function addCustomItemToOrder(
  priceDifference: number,
  customItemName: string,
  calculatedOrderId: string,
  admin: any,
) {
  const mutation = `
      mutation addCustomItemToOrder($id: ID!, $title: String!, $quantity: Int!, $amount: Decimal!, $currencyCode: CurrencyCode!) {
        orderEditAddCustomItem(id: $id, title: $title, quantity: $quantity, price: { amount: $amount, currencyCode: $currencyCode }) {
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

  console.log("Adding ", customItemName, " to order");
  const response = await admin.graphql(mutation, {
    variables: {
      id: calculatedOrderId,
      title: customItemName,
      quantity: 1,
      amount: priceDifference.toFixed(2),
      currencyCode: "USD",
    },
  });

  const data = await response.json();

  console.log("Add custom item response data: ", data.data);

  if (data.data?.orderEditAddCustomItem?.userErrors?.length) {
    console.log(
      "USER ERRORS: ",
      data.data?.orderEditAddCustomItem?.userErrors,
    );
    throw new Error("Unable to add custom item to order");
  }
}

/**
 * Adds a discount to a line item to make up the price difference between
 * the expected weight of the item and the actual weight
 *
 * @param priceDifference the actual item price minus the original item price
 *
 */
async function addDiscountToLineItem(
  priceDifference: number,
  discountName: string,
  calculatedOrderId: string,
  calculatedLineItemId: string,
  admin: any,
) {
  const mutation = `
    mutation orderEditAddLineItemDiscount($discount: OrderEditAppliedDiscountInput!, $id: ID!, $lineItemId: ID!) {
      orderEditAddLineItemDiscount(
        discount: $discount
        id: $id
        lineItemId: $lineItemId
      ) {
        addedDiscountStagedChange {
          id
          __typename
          value {
            __typename
            ... on MoneyV2 {
              amount
              currencyCode
            }
          }
        }
        calculatedLineItem {
          id
          calculatedDiscountAllocations {
            discountApplication {
              id
              description
            }
          }
          stagedChanges {
            __typename
            ... on OrderStagedChangeAddLineItemDiscount {
              value {
                __typename
                ... on MoneyV2 {
                  amount
                  currencyCode
                }
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

  console.log("Adding discount to order.");
  const response = await admin.graphql(mutation, {
    variables: {
      discount: {
        description: `${discountName}`,
        fixedValue: {
          amount: priceDifference,
          currencyCode: "USD",
        },
      },
      id: calculatedOrderId,
      lineItemId: calculatedLineItemId,
    },
  });

  // After we add the discount to the order, we are returned an ID,
  // now we must edit the discount's name to save the ID for when we want to remove it.

  const data = await response.json();
  console.log("Add discount response data: ", data.data);
  if (data.data?.orderEditAddLineItemDiscount?.userErrors?.length) {
    console.log(
      "USER ERRORS: ",
      data.data?.orderEditAddLineItemDiscount?.userErrors,
    );
    throw new Error("Error adding discount to order");
  }

  const lineItemDiscounts =
    data.data?.orderEditAddLineItemDiscount?.calculatedLineItem
      ?.calculatedDiscountAllocations;
  let discountId = null;
  lineItemDiscounts.forEach((discount: any) => {
    console.log("Discount: ", discount);
    if (
      discount.discountApplication.description.includes(
        "Price difference",
      )
    ) {
      discountId = discount.discountApplication.id;
    }
  });

  if (!discountId) return;

  const mutationUpdateDiscount = `
    mutation orderEditUpdateDiscount($discount: OrderEditAppliedDiscountInput!, $discountApplicationId: ID!, $id: ID!) {
      orderEditUpdateDiscount(discount: $discount, discountApplicationId: $discountApplicationId, id: $id) {
        userErrors {
          field
          message
        }
      }
    }
  `;

  const updateDiscountResponse = await admin.graphql(mutationUpdateDiscount, {
    variables: {
      id: calculatedOrderId,
      discountApplicationId: discountId,
      discount: {
        // Not sure why discountId would be 'never' here,
        // but whatever u say typescript little buddy
        description: `${discountName} discount_id:${(discountId as string).replace("gid://shopify/CalculatedManualDiscountApplication/", "")}`,
        fixedValue: {
          amount: priceDifference,
          currencyCode: "USD",
        },
      },
    },
  });

  const updateDiscountData = await updateDiscountResponse.json();
  console.log("update discount data: ", updateDiscountData.data);
}

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const ctx = await authenticate.admin(request);
  const { admin, redirect } = ctx;
  const orderId = params.orderId; // Assuming orderId comes from params
  if (!orderId) return;

  const shopUrl = ctx.session.shop;
  /**
   * IF we try to add a discount or custom item for an item that has already been edited,
   * we must remove the custom item upcharge or the discount associated with the line item.
   *
   * To remove the custom item, we can get all items from the order, find the custom items,
   * and pair it up with the item we are editing by ID.
   * Then make a graphql call to remove the custom item.
   *
   * To remove discounts, loop through all discounts and match by id.
   * Then make a graphql call to remove the discount.
   *
   *
   * First, I'll pass the custom items and discounts to the action function
   */

  console.log("Editing order ID: ", orderId);

  const formData = await request.formData();
  // This is [[string id, LineItem lineItem], [string id, LineItem lineItem]...]
  const editedLineItems = JSON.parse(
    (formData.get("editedLineItems") as string) || "{}",
  );
  const customLineItems = JSON.parse(
    (formData.get("customLineItems") as string) || "{}",
  );

  let discounts = JSON.parse((formData.get("discounts") as string) || "{}");

  console.log("Got discounts in backend: ", discounts);
  if (!Object.keys(discounts).length) {
    discounts = [];
  }

  console.log("Custom items in action func: ", customLineItems);
  console.log("Discounts in action func: ", discounts);

  // if (Object.keys(customLineItems).length || Object.keys(discounts).length) {
  //   const shopifyOrderUrl = `https://${shopUrl}/admin/orders/${orderId}`;
  //   return redirect(shopifyOrderUrl, { target: "_parent" });
  // }

  // console.log(editedLineItems);

  // so for each line item, create a custom line item with its properties and remove the line item with the id
  const mutationBeginEdit = `
    mutation beginEdit($id: ID!) {
      orderEditBegin(id: $id){
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

  const beginEditResponse = await admin.graphql(mutationBeginEdit, {
    variables: { id: `gid://shopify/Order/${orderId}` },
  });
  const beginEditData = await beginEditResponse.json();

  if (beginEditData.data?.orderEditBegin?.userErrors?.length) {
    console.error(
      "User Errors:",
      beginEditData.data.orderEditBegin.userErrors,
    );
  }

  const calculatedOrderId =
    beginEditData.data?.orderEditBegin?.calculatedOrder?.id;

  if (!calculatedOrderId) {
    console.log(beginEditData.data?.orderEditBegin?.userErrors?.length);
    throw new Error(
      "Cannot edit orders with the local delivery shipping option",
    );
  }

  const mutationRemoveItem = `
    mutation removeLineItem ($calculatedOrderId: ID!, $calculatedLineItemId: ID!)  {
      orderEditSetQuantity(id: $calculatedOrderId, lineItemId: $calculatedLineItemId, quantity: 0) {
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

  for (const customItem of customLineItems) {
    /**
     * When I remove a line item, I need to update the price of the line item
     * that the custom line item refers to. Consider the case that a custom item
     * has an upcharge of $1, and we want to reduce the upcharge to 0.50c
     * If we don't update the line item, the app will think that the price needs
     * to be reduced still, and will add a discount of 0.50c instead of an upcharge of 0.50c
     */
    const calculatedLineItemId = customItem[1].id.replace(
      "LineItem",
      "CalculatedLineItem",
    );
    const removeItemResponse = await admin.graphql(mutationRemoveItem, {
      variables: {
        calculatedOrderId: calculatedOrderId,
        calculatedLineItemId: calculatedLineItemId,
      },
    });
    const removeItemData = await removeItemResponse.json();
    console.log(removeItemData);

    // Update the price of the line item to reflect the removed upcharge
    editedLineItems.forEach((editedLineItem: any) => {
      console.log(editedLineItem[0]);
      if (editedLineItem[0] === customItem[0]) {
        editedLineItem[1].initialTotal = (
          parseFloat(editedLineItem[1].initialTotal) -
          parseFloat(customItem[1].upchargeAmount)
        ).toFixed(2);
      }
    });
  }

  console.log("Went through all custom line items.");
  console.log(
    "Edited line items after removing upcharges: ",
    editedLineItems,
  );

  // const mutationRemoveDiscount = `
  //   mutation orderEditRemoveDiscount($discountApplicationId: ID!, $id: ID!) {
  //     orderEditRemoveDiscount(discountApplicationId: $discountApplicationId, id: $id) {
  //       userErrors {
  //         field
  //         message
  //       }
  //     }
  //   }
  // `;

  // for (const discount of discounts) {
  //   console.log("Reviewing discount: ", discount);
  //   const discountApplicationId =
  //     "gid://shopify/CalculatedManualDiscountApplication/" +
  //     discount[1].description.split("discount_id:")[1].split(" ")[0];
  //
  //   const discountCalculatedOrderId =
  //     "gid://shopify/CalculatedOrder/" +
  //     discount[1].description.split("session_id:")[1];
  //   const removeDiscountResponse = await admin.graphql(
  //     mutationRemoveDiscount,
  //     {
  //       variables: {
  //         id: discountCalculatedOrderId,
  //         discountApplicationId: discountApplicationId,
  //       },
  //     },
  //   );
  //
  //   const removeDiscountData = await removeDiscountResponse.json();
  //   console.log(
  //     removeDiscountData.data.orderEditRemoveDiscount?.userErrors,
  //   );
  //
  //   editedLineItems.forEach((item: any) => {
  //     console.log("Reviewing Item: ", item);
  //     if (discount[0] === item[0]) {
  //       item[1].initialTotal = (
  //         parseFloat(item[1].initialTotal) +
  //         parseFloat(discount[1].amount)
  //       ).toFixed(2);
  //     }
  //   });
  // }
  // I may have to remove the whole line item, then re-add it to the order.
  // I don't think there's a way to remove a discount that was added by this app
  // because the discounts we create are 'ephemeral', they don't actually exist in the store,
  // they are like "custom discounts", so there's no way to specify which discount to remove...

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for (const [_, lineItem] of editedLineItems) {
    const quantity = lineItem.quantity;
    if (!quantity) continue;
    const total = lineItem.total;
    let title = lineItem.title;

    // console.log("Adding custom line item: ", lineItem);

    const priceDifference = total - lineItem.initialTotal;
    const lineItemId = lineItem.id.split("/").filter(Boolean).pop();
    const editTitle = `Price difference between ${title}'s expected and actual weight (${lineItem.finalWeight}lbs) references_item:${lineItemId}`;

    if (priceDifference > 0) {
      await addCustomItemToOrder(
        priceDifference,
        editTitle,
        calculatedOrderId,
        admin,
      );
    } else if (priceDifference < 0) {
      // Check
      await addDiscountToLineItem(
        Math.abs(priceDifference),
        editTitle,
        calculatedOrderId,
        lineItem.id.replace("LineItem", "CalculatedLineItem"),
        admin,
      );
    }
  }

  const commitEditMutation = `
    mutation commitEdit($id: ID!) {
      orderEditCommit(id: $id, notifyCustomer: false, staffNote: "Final order weight") {
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

  console.log("Committing order.");
  const commitEditResponse = await admin.graphql(commitEditMutation, {
    variables: {
      id: calculatedOrderId,
    },
  });

  const commitEditData = await commitEditResponse.json();
  if (commitEditData.data?.userErrors?.length) {
    console.log(commitEditData.data.userErrors);
    throw new Error("Unable to commit order edits");
  }

  const shopifyOrderUrl = `https://${shopUrl}/admin/orders/${orderId}`;
  return redirect(shopifyOrderUrl, { target: "_parent" });
};

interface Variant {
  id: string;
  displayName: string;
  price: string;
  selectedOptions: {
    name: string;
    value: string;
  }[];
}

interface LineItem {
  id: string;
  image: string;
  title: string;
  quantity: string;
  pricePerLb: string;
  finalWeight: string;
  total: string;
  variant?: Variant;
  [key: string]: string | Variant | undefined;
}

type LineItems = Map<string, LineItem>;

interface CustomLineItem {
  id: string;
  title: string;
  upchargeAmount: string;
}

function separateActualFromCustomLineItems(order: any) {
  let actualLineItems = new Map<string, LineItem>();
  let customLineItems = new Map<string, CustomLineItem>();
  order.lineItems.nodes.forEach((item: any) => {
    if (item.refundableQuantity < 1) return;
    if (item.variant) {
      actualLineItems.set(item.id, item);
    } else {
      // It's a custom line item
      const customLineItem = {
        id: item.id,
        title: item.title,
        upchargeAmount:
          item.discountedUnitPriceSet.presentmentMoney.amount,
      };
      const customLineItemTitleArr = customLineItem.title.split(" ");
      const customLineItemReferencesLineItemId =
        "gid://shopify/LineItem/" +
        customLineItemTitleArr[customLineItemTitleArr.length - 1].split(
          "references_item:",
        )[1];
      customLineItems.set(
        customLineItemReferencesLineItemId,
        customLineItem,
      );
    }
  });

  return { actualLineItems, customLineItems }; // Ensure the map is returned
}

/**
 * Applies the preexisting edits (upcharges/discounts) to each line item
 *
 * @param {any} actualLineItems - The line items from the original order, not including custom line items
 * @param {Map<string, CustomLineItem>} customLineItems - The custom line items (upcharges) associated with the order
 */
function applyPreexistingEditsToLineItems(
  actualLineItems: Map<string, LineItem>,
  customLineItems: Map<string, CustomLineItem>,
): Map<string, LineItem> {
  console.log("Applying edits.");
  console.log("Actual line items before applying edits: ", actualLineItems);
  console.log("Custom line item upcharges: ", customLineItems);
  // For each custom line item, match the id with the actual line item and add the upcharge to the line item's total
  // For each discount, match the id with the actual line item and subtract the discount amount from the line item's total
  const lineItemsAfterEdits = new Map<string, LineItem>(actualLineItems);
  Array.from(customLineItems.values()).map(
    (customLineItem: CustomLineItem) => {
      // The format of the title is <description> <id>
      const titleSplit = customLineItem.title.split(" ");
      const customLineItemId =
        "gid://shopify/LineItem/" +
        titleSplit[titleSplit.length - 1].split("references_item:")[1];

      console.log("Custom line item ID: ", customLineItemId);
      const actualLineItem = actualLineItems.get(customLineItemId);
      if (!actualLineItem) return null;

      // It would probably be most intuitive for the user to just ignore other discounts that aren't associated with this app.
      const upcharge = parseFloat(customLineItem.upchargeAmount);
      console.log("Applying upcharge of ", upcharge);

      actualLineItem.total = (
        parseFloat(actualLineItem.total) + upcharge
      ).toFixed(2);
      lineItemsAfterEdits.set(customLineItemId, actualLineItem);

      return customLineItem;
    },
  );

  return lineItemsAfterEdits;
}

interface Discount {
  amount: number;
  weight: string;
  description: string;
}

/**
 * Returns a map in the form
 * lineItemId: string -> Discount
 */
function cleanDiscounts(discounts: any): Map<string, Discount> {
  const cleanedDiscounts: Map<string, Discount> = new Map<string, Discount>();
  discounts.forEach((discount: any) => {
    const discountTitleArr = discount.description?.split(" ");
    console.log("Discount title arr: ", discountTitleArr);
    if (!discountTitleArr) return;
    const discountReferencesItemId =
      "gid://shopify/LineItem/" +
      discountTitleArr[discountTitleArr.length - 2].split(
        "references_item:",
      )[1];

    console.log("Discount references item ID: ", discountReferencesItemId);
    const itemWeight = extractWeightFromTitle(discount.title);

    const cleanedDiscount: Discount = {
      description: discount.description,
      amount: parseFloat(discount.value.amount),
      weight: itemWeight,
    };
    cleanedDiscounts.set(discountReferencesItemId, cleanedDiscount);
  });

  return cleanedDiscounts;
}

/**
 * Clean the line items to match the LineItem interface
 */
function cleanLineItems(actualLineItems: Map<string, any>) {
  const cleanedLineItems = new Map<string, LineItem>();
  Array.from(actualLineItems.values()).forEach((item) => {
    const cleanedLineItem: LineItem = {
      id: item.id,
      image: item.image?.url,
      title:
        item.variant?.displayName.replace(" - Default Title", "") ||
        item.title,
      quantity: item.refundableQuantity,
      pricePerLb: "0.00",
      finalWeight: "0.00",
      // The total does not include the quantity in the GraphQL response, apply the quantity here
      total: (
        parseFloat(
          item.discountedUnitPriceSet.presentmentMoney.amount,
        ) * parseInt(item.refundableQuantity)
      ).toFixed(2),
      variant: item.variant,
    };

    cleanedLineItems.set(item.id, cleanedLineItem);
  });

  return cleanedLineItems;
}

function extractWeightFromTitle(title: string): string {
  // The weight will be in the title of the custom line item
  console.log("Extracting weight from title: ", title);
  const weightExtractRegex = /(?<=\()[^)]+(?=\))/;
  const weightMatches = title.match(weightExtractRegex);

  console.log("Weight matches: ", weightMatches);
  let weight = "1.00";
  if (weightMatches?.length) {
    weightMatches.forEach((match: string) => {
      const matchArr = match.split("lbs");
      if (matchArr.length) {
        weight = matchArr[0];
      }
    });
  }
  console.log("Got weight from discount/upcharge title: ", weight);
  return parseFloat(weight).toFixed(2);
}

function extractWeightFromVariantTitle(title: string): string {
  const titleArr = title.split("-");
  const weightArr = titleArr[titleArr.length - 1].trim().split(" ");
  console.log("Weight arr: ", weightArr);
  const weight = weightArr[0];
  return parseFloat(weight).toFixed(2);
}

/**
 * Takes in raw line items with preexisting edits done (custom upcharges applied)
 * Cleans the data to match the LineItem interface and makes final calculations
 * of the item's price per lb
 */
function calculateLineItemData(
  cleanedLineItems: any,
  customLineItems: any,
  discounts: any,
): Map<string, LineItem> {
  const finalLineItems = new Map<string, LineItem>();

  cleanedLineItems.forEach((lineItem: LineItem) => {
    let weight: string | null = null;
    console.log("Current line item ID: ", lineItem.id);
    // 1. The weight is explicitly stated in the custom item upcharge or discount name
    const customLineItemAssociatedWithThisLineItem = customLineItems.get(
      lineItem.id,
    );

    console.log(
      "Custom line item associated with this line item: ",
      customLineItemAssociatedWithThisLineItem,
    );
    if (customLineItemAssociatedWithThisLineItem) {
      console.log("Item has upcharge");
      console.log(
        "Extracting weight from object: ",
        customLineItemAssociatedWithThisLineItem,
      );
      // This item has an upcharge
      weight = extractWeightFromTitle(
        customLineItemAssociatedWithThisLineItem.title,
      );
    }

    if (weight !== null && !isNaN(parseFloat(weight))) {
      console.log("Setting weight obtained from upcharge: ", weight);
      const finalLineItem: LineItem = {
        ...lineItem,
        // We don't multiply by quantity here because we were explicitly told the weight
        finalWeight: weight,
        pricePerLb: (
          parseFloat(lineItem.total) / parseFloat(weight)
        ).toFixed(2),
      };

      finalLineItems.set(lineItem.id, finalLineItem);
      return;
    }
    const discountAssociatedWithThisLineItem = discounts.get(lineItem.id);
    console.log(
      "Discount associated with this line item: ",
      discountAssociatedWithThisLineItem,
    );
    if (discountAssociatedWithThisLineItem) {
      // This item has a discount
      weight = discountAssociatedWithThisLineItem.weight;
    }

    if (weight !== null && !isNaN(parseFloat(weight))) {
      console.log("Setting weight obtained from discount: ", weight);
      const finalLineItem: LineItem = {
        ...lineItem,
        // We don't multiply by quantity here because we were explicitly told the weight
        finalWeight: weight,
        pricePerLb: (
          parseFloat(lineItem.total) / parseFloat(weight)
        ).toFixed(2),
      };

      finalLineItems.set(lineItem.id, finalLineItem);
      return;
    }

    // 2. The weight is explicitly stated in the item's variant
    if (lineItem.variant) {
      weight = extractWeightFromVariantTitle(
        lineItem?.variant?.displayName,
      );
    }

    if (weight !== null && !isNaN(parseFloat(weight))) {
      console.log("Setting weight obtained from variant title: ", weight);
      const finalLineItem: LineItem = {
        ...lineItem,
        finalWeight: (
          parseFloat(weight) * parseInt(lineItem.quantity)
        ).toFixed(2),
        pricePerLb: (
          parseFloat(lineItem.total) /
          parseInt(lineItem.quantity) /
          parseFloat(weight)
        ).toFixed(2),
      };

      finalLineItems.set(lineItem.id, finalLineItem);
      return;
    }

    // 3. We guess the weight is 1.00
    weight = "1.00";

    const finalLineItem: LineItem = {
      ...lineItem,
      finalWeight: (
        parseFloat(weight) * parseInt(lineItem.quantity)
      ).toFixed(2),
      pricePerLb: (
        parseFloat(lineItem.total) /
        parseInt(lineItem.quantity) /
        parseFloat(weight)
      ).toFixed(2),
    };

    finalLineItems.set(lineItem.id, finalLineItem);
  });

  console.log("FINAL LINE ITEMS: ", finalLineItems);
  return finalLineItems;
}

export default function OrderDetails() {
  const loaderData = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const navigate = useNavigate();
  const uneditedLineItemsRef = useRef<LineItems | null>(null);
  const customLineItemsRef = useRef<Map<string, CustomLineItem> | null>(null);
  const discountsRef = useRef<any>(null);
  const [lineItems, setLineItems] = useState<LineItems>(
    new Map<string, LineItem>(),
  ); // State for edited line items

  const useEffectRanRef = useRef<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(false);

  useEffect(() => {
    if (useEffectRanRef.current) return;
    useEffectRanRef.current = true;
    console.log("USE EFFECT RUNNING");
    const { actualLineItems, customLineItems } =
      separateActualFromCustomLineItems(loaderData.order);

    const cleanedLineItems = cleanLineItems(actualLineItems);
    applyPreexistingEditsToLineItems(cleanedLineItems, customLineItems);

    const cleanedDiscounts = cleanDiscounts(loaderData.discounts);
    const finalLineItems = calculateLineItemData(
      cleanedLineItems,
      customLineItems,
      cleanedDiscounts,
    );

    console.log("FINAL LINE ITEMS: ", finalLineItems);

    uneditedLineItemsRef.current = finalLineItems;
    customLineItemsRef.current = customLineItems;
    discountsRef.current = cleanedDiscounts;
    setLineItems(finalLineItems);
  }, [loaderData.order, loaderData.discounts]);

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

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    // setIsLoading(true);
    if (!uneditedLineItemsRef.current) return;
    const editedLineItems: LineItems = new Map<string, LineItem>();
    for (const lineItem of lineItems) {
      const id = lineItem[0];
      const item = lineItem[1];

      const uneditedLineItem = uneditedLineItemsRef.current.get(id);
      if (!uneditedLineItem) continue;

      // If the total price doesn't change, don't edit the item
      if (uneditedLineItem.total !== item.total) {
        item.initialTotal = uneditedLineItem.total;
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

    if (customLineItemsRef.current) {
      formData.append(
        "customLineItems",
        JSON.stringify(
          Array.from(customLineItemsRef.current.entries()),
        ),
      );
    }

    if (discountsRef.current) {
      console.log("Sending discounts to backend: ", discountsRef.current);
      formData.append(
        "discounts",
        JSON.stringify(Array.from(discountsRef.current.entries())),
      );
    }

    submit(formData, { method: "POST" });
  };

  const handleWeightChange = (id: string, value: string) => {
    const decimalRegex = /^\d*\.?\d*$/;
    if (!decimalRegex.test(value)) return;

    const newLineItems = structuredClone(lineItems);
    const newLineItem = newLineItems.get(id);
    if (!newLineItem) return; // This should never happen

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
        isNaN(parseFloat(item.pricePerLb)) ? (
          "N/A"
        ) : (
          "$" + item.pricePerLb
        )
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
    <Page fullWidth title="Edit Order Weight">
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
              Order {loaderData.order.name}
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
              <div
                style={{
                  width: "6rem",
                  display: "flex",
                  justifyContent: "center",
                }}
              >
                {isLoading ? (
                  <Spinner
                    size="small"
                    accessibilityLabel="loading spinner"
                  />
                ) : (
                  <Button
                    variant="primary"
                    onClick={handleSubmit as () => unknown}
                  >
                    Save Edits
                  </Button>
                )}
              </div>
            </InlineStack>
          </Form>
        </Card>
      </BlockStack>
    </Page>
  );
}
