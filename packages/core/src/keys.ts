/** DynamoDB シングルテーブルのキー定義（docs/design.md §6.1） */
export const keys = {
  user: (sub: string) => ({ PK: `USER#${sub}`, SK: "PROFILE" }),
  userByEmail: (email: string) => ({ GSI1PK: `EMAIL#${email}`, GSI1SK: "USER" }),
} as const;

export const GSI1 = "GSI1";
export const GSI2 = "GSI2";
