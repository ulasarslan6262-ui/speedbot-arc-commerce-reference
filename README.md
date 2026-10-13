# Speedbot Arc commerce reference

This standalone reference component is published under the MIT License. It provides inspectable network configuration, a Circle x402 facilitator adapter and a durable payment-context ledger for the live Speedbot Arc beta integration.

These are the same network, Circle facilitator and durable ledger modules used in the isolated Speedbot Arc tests. The extract excludes the private application, production database, customer data, keys, environment files, operating balances and git history. Speedbot 3.31.0 is live with all twelve Arc beta capabilities. This extract reproduces its included network/facilitator/ledger component; it does not contain the full Speedbot application.

Base and Arc signing domains are separate. Original network/provider/recipient/terms persist. Circle pending IDs use the official status route. Financial budgets stay separate, and Arc income never automatically funds rewards. Arc native gas and the ERC-20 USDC view share one balance. Circle does not settle undeployed ERC-6492 wallets.

With Node 24, run `npm ci`, then `npm test`. Tests generate disposable keys in memory and submit no transactions. Private mainnet canaries use the owner's approved test budget. These internal tests are validation, not independent customer demand.

Official sources: https://docs.arc.io/arc/references/connect-to-arc · https://developers.circle.com/facilitator-service/supported-networks · https://developers.circle.com/facilitator-service/quickstart · https://developers.circle.com/facilitator-service/keyless-trial · https://developers.circle.com/facilitator-service/sign-seller-proof · https://docs.x402.org/core-concepts/facilitator

Speedbot: https://speedbot.dev — `/api/payment-capabilities` gives the current live availability. Configured adapters alone are not proof of end-to-end support.
