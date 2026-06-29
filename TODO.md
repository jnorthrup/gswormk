 
 High-level thesis 
 We do not need live broker integration yet. The real priority is proving the simulated exchange can emit orders only when there is measurable, out-of-sample edge. 
 
 The TODO should deepen around two distinct alpha classes: 
 
 1. Maximum discounts: 
 Mean-reversion / liquidity-discount entries where price is temporarily below fair value after stress, imbalance, or overreaction. 
 
 2. Clearest growth signals: 
 Momentum / continuation entries where price is breaking upward with independent confirmation, not just duplicated versions of the same signal. 
 
 The current system has many signal parts, but the core weakness is not “more signals.” It is: 
 - no proof that signals are orthogonal 
 - no proof advantageProbability is calibrated 
 - no walk-forward proving ground 
 - Kelly can explode when downside variance is floored 
 - portfolio sizing is still too symbol-independent 
 - “discount” and “growth” are not separated as different trade archetypes 
 
 Recommended TODO deepening 
 
 1. Add explicit trade archetypes: DISCOUNT vs GROWTH 
 
 Current signal pipeline collapses everything into one drift/Kelly/trigger path. That hides whether an order is: 
 - buying a statistically cheap pullback 
 - buying trend continuation 
 - reacting to noise 
 
 Add a required tradeArchetype on every emitted signal/order: 
 
 - discount_reversion 
 - growth_momentum 
 - volatility_defense 
 - no_edge 
 
 Gate: 
 Every order must declare one archetype and pass that archetype’s independent evidence checks. 
 
 Suggested checks: 
 
 discount_reversion: 
 - price dislocation: Kalman innovationZ < negative threshold, or RSI displacement oversold 
 - book support: OBI / L2 wall does not confirm continued sell pressure 
 - downside variance not expanding too fast 
 - BTC tailDependence below danger threshold 
 - expected reversion > effective spread + fee + slippage + model uncertainty 
 
 growth_momentum: 
 - positive innovationZ 
 - positive OBI or bid-side persistence 
 - timescaleAttention agrees across multiple windows 
 - RSI support is directional, not overextended 
 - alignmentScore above threshold 
 - expected continuation > effective spread + fee + slippage + model uncertainty 
 
 volatility_defense: 
 - tailDependence elevated 
 - annualizedRvDown elevated 
 - correlation rising 
 - action is reduce/hold, not add 
 
 This makes “maximum discount” and “clearest growth” measurable rather than rhetorical. 
 
 2. Add “edge decomposition” per signal/order 
 
 Every order should persist an explicit edge stack: 
 
 grossEdgeBps: 
 - expected drift / expected reversion in basis points 
 
 costBps: 
 - spread 
 - taker/maker fee 
 - slippage estimate 
 - latency/staleness penalty 
 
 uncertaintyBps: 
 - Kalman uncertainty 
 - signal disagreement penalty 
 - parameter uncertainty from walk-forward folds 
 - cache quality penalty 
 
 netEdgeBps: 
 - grossEdgeBps - costBps - uncertaintyBps 
 
 Gate: 
 No order if netEdgeBps <= 0. 
 
 Better gate: 
 No order unless: 
 netEdgeBps >= minEdgeBpsByRegime[dominantRegime] 
 
 This is the cleanest way to enforce TODO L0: “every emitted order carries verified, measurable edge.” 
 
 3. Fix Kelly semantics before trusting any sizing 
 
 Current Kelly form: 
 effectiveDrift / (rvDown + EPSILON) * (1 - tailDependence) 
 
 Quant issue: 
 When rvDown hits floor, Kelly can explode. That creates fake conviction exactly when risk estimate is least trustworthy. 
 
 Add uncertainty-aware Kelly: 
 
 kelly = netEdge / (downsideVariance + modelVariance + parameterVariance) 
 
 Then cap: 
 - hard cap: maxKellyFraction 
 - regime cap 
 - volatility cap 
 - correlation cap 
 - fat-finger cap 
 
 Critical rule: 
 If downside variance is only the floor because there is insufficient negative-return evidence, do not treat it as low risk. Treat it as unknown risk. 
 
 Gate: 
 If rvDown <= varianceFloor && sampleCount < minRiskSamples, Kelly = 0 or heavily discounted. 
 
 This locks in “maximum discounts” because the system stops overbetting fake smoothness. 
 
 4. Add signal orthogonality audit before ensemble weight optimization 
 
 Current drift synthesis: 
 (obi + innovationZ) * alignment * cacheQuality + multiscaleDrift 
 
 Quant issue: 
 OBI, Kalman innovationZ, RSI innovation, and timescale drift may all encode the same recent price/order-flow move. Summing them can double-count conviction. 
 
 Add an L2 task: 
 
 Signal orthogonality audit: 
 - persist signal components per tick/order 
 - compute rolling pairwise correlation matrix: 
 - OBI 
 - innovationZ 
 - RSI displacement 
 - RSI innovationZ 
 - timescale weightedDrift 
 - timescale weightedRewardRisk 
 - alignment 
 - cacheQuality 
 - tailDependence 
 - flag pairs with |ρ| > 0.7 
 - compute marginal Sharpe contribution per signal 
 - prune or decorrelate signals that are redundant 
 
 For decorrelation: 
 - simple first pass: residualize later signals against stronger signals 
 - e.g. innovationZ_residual = innovationZ - beta * obi 
 - only ensemble residuals, not raw duplicated signal 
 
 Gate: 
 No learned ensemble until pairwise correlations are measured and stored. 
 
 This is core to “clearest growth signals”: growth must be confirmed by independent evidence, not five correlated echoes. 
 
 5. Split confidence into prediction and calibration 
 
 Current advantageProbability is model-implied, not proven. 
 
 Add two fields: 
 - rawAdvantageProbability 
 - calibratedAdvantageProbability 
 
 Workflow: 
 1. Bin historical closed trades by rawAdvantageProbability decile. 
 2. Compute actual hit rate per decile. 
 3. Compute calibration error. 
 4. Fit monotonic/isotonic mapping if error > threshold. 
 5. Use calibrated probability for: 
 - Kelly 
 - maker/taker choice 
 - snare sizing 
 - order acceptance 
 
 Gate: 
 No “competence” claim until predicted vs actual hit rate is within ±5% across deciles, or at least across populated deciles. 
 
 This is the bridge between signal math and actual trade outcome. 
 
 6. Add walk-forward as the central proving ground 
 
 L1 should become the main engine of truth. Suggested concrete shape: 
 
 CLI: 
 node src/cli.mjs backtest --symbols BTC-USD,ETH-USD --train-days 30 --test-days 7 --step-days 1 --strategy current 
 
 Fold process: 
 - train fold: 
 - calibrate Kalman Q/R 
 - calibrate ensemble weights 
 - calibrate trigger multipliers 
 - calibrate confidence mapping 
 - test fold: 
 - freeze parameters 
 - replay candles/ticks 
 - emit simulated orders 
 - close trades 
 - record metrics 
 
 Per-fold metrics: 
 - Sharpe 
 - Sortino 
 - Calmar 
 - max drawdown 
 - hit rate 
 - break-even hit rate 
 - profit factor 
 - average netEdgeBps 
 - realized edge capture ratio: 
 realizedPnlBps / predictedNetEdgeBps 
 - calibration error 
 - turnover 
 - fee drag 
 - slippage drag 
 
 Gate: 
 Do not accept parameter changes unless out-of-sample metrics improve, not just in-sample. 
 
 7. Add discount-specific metrics 
 
 For “maximum discounts,” add explicit discount-quality measurements: 
 
 - distance from fair value: 
 - Kalman residual 
 - z-score from rolling VWAP / EMA 
 - RSI displacement from neutral 
 - discount capture: 
 - entry price vs next N-minute fair value 
 - entry price vs fold-local lower quantile 
 - adverse excursion: 
 - max adverse excursion after entry 
 - reversion half-life: 
 - time until signal mean-reverts 
 - failed discount rate: 
 - discount entries that continue falling beyond stop threshold 
 
 Discount gate: 
 A discount trade is valid only if historical fold data shows: 
 - positive average reversion after equivalent signal state 
 - adverse excursion bounded 
 - tailDependence below threshold 
 - realized reversion exceeds costs 
 
 8. Add growth-specific metrics 
 
 For “clearest growth signals,” add: 
 
 - breakout confirmation: 
 - innovationZ positive and persistent 
 - OBI positive and persistent 
 - timescale agreement across 1/5/15/60 windows 
 - continuation half-life 
 - pullback tolerance 
 - trend failure rate 
 - signal crowding: 
 - high momentum but deteriorating OBI means weak continuation 
 - overextension penalty: 
 - RSI too high without volume/book confirmation reduces edge 
 
 Growth gate: 
 A growth trade is valid only if: 
 - multiple timescales agree 
 - calibrated hit rate for the signal bucket exceeds break-even 
 - continuation expectation exceeds fees/slippage/uncertainty 
 - volatility regime does not imply chop/false breakout 
 
 9. Add portfolio-level correlation and tail-risk rules before live broker 
 
 Current risk looks too per-symbol. For crypto, that is dangerous. 
 
 Add: 
 - rolling return correlation matrix 
 - portfolio variance estimate: wᵀΣw 
 - BTC tail-dependence exposure scaler 
 - aggregate crypto exposure cap when correlations rise 
 - volatility-scaled max position 
 
 Rules: 
 - if BTC tailDependence > 0.3: 
 allTargetWeights *= (1 - tailDependence) 
 - if average pairwise correlation > threshold: 
 reduce total exposure 
 - per-symbol cap: 
 effectiveMaxPositionPct = maxPositionPct / (1 + annualizedRvDown / 10) 
 
 This prevents false “discounts” during market-wide crash correlation. 
 
 10. Add signal decay tracking 
 
 Every signal should earn its place. 
 
 For each component: 
 - compute rolling marginal Sharpe 
 - compute hit-rate contribution 
 - compute incremental information coefficient 
 - compute decay half-life 
 - demote if contribution < 0 over rolling window 
 
 Gate: 
 No signal remains active forever by default. 
 
 This protects against alpha decay. 
 
 11. Add data quality as alpha protection 
 
 Before walk-forward matters, candle integrity must be enforced. 
 
 Add hard assertions after candle fetch/upsert: 
 - open > 0 
 - high >= max(open, close) 
 - low <= min(open, close) 
 - volume >= 0 
 - timestamp monotonic per symbol/granularity 
 - gap count recorded 
 - interpolation flagged, never hidden 
 
 Add staleness: 
 - if no candle within 2 × granularity: 
 - log warning 
 - set cacheQuality lower, e.g. 0.1 
 - block high-confidence orders if stale 
 
 Bad data creates fake discounts and fake breakouts. This belongs before any L1 proof. 
 
 12. Suggested revised build order 
 
 Given your stated priority — simulated exchange competence before live broker — I’d reorder: 
 
 1. Clean failing tests / restore baseline 
 - Especially current engine/test mismatches. 
 - Do not touch LiveBroker. 
 
 2. L5 data quality assertions 
 - Prevent fake alpha from malformed candles. 
 
 3. L5 historical backfill command 
 - Needed for walk-forward. 
 
 4. L1 walk-forward harness 
 - The proof engine. 
 
 5. L2 edge decomposition 
 - grossEdgeBps, costBps, uncertaintyBps, netEdgeBps. 
 
 6. L2 trade archetypes 
 - discount_reversion vs growth_momentum vs volatility_defense. 
 
 7. L2 orthogonality audit 
 - stop double-counting signals. 
 
 8. L2 confidence calibration 
 - raw pAdv → calibrated pAdv. 
 
 9. L3 Kelly/risk correction 
 - uncertainty-aware Kelly, variance-floor guard, vol-scaled caps. 
 
 10. L3 correlation/tail budget 
 - portfolio-level protection. 
 
 11. L0 binomial gate 
 - rolling 200-trade proof. 
 
 12. Only then revisit L4 live broker. 
 
 The sharpest TODO additions 
 
 Add this to TODO as a new L2/L3 bridge: 
 
 “Every signal must persist an edge decomposition: grossEdgeBps, spreadBps, feeBps, slippageBps, uncertaintyBps, netEdgeBps. Orders are blocked unless netEdgeBps > 
 0 and calibratedAdvantageProbability exceeds the break-even probability implied by reward-risk.” 
 
 Add this to L2: 
 
 “Trade archetype classifier: classify every candidate as discount_reversion, growth_momentum, volatility_defense, or no_edge. Each archetype has separate gates, 
 metrics, and walk-forward calibration.” 
 
 Add this to L1: 
 
 “Walk-forward must report per-archetype metrics: discount capture rate, growth continuation rate, false discount rate, false breakout rate, edge capture ratio, 
 calibration error, and netEdgeBps realized vs predicted.” 
 
 Add this to L3: 
 
 “Kelly must include model uncertainty and must not explode when downside variance is at floor. If rvDown is floor-derived due to insufficient samples, treat risk 
 as unknown and cap/zero Kelly.” 
 
 Bottom line 
 The strongest path is not LiveBroker. It is: 
 
 Data integrity → walk-forward → explicit edge decomposition → archetype-specific gates → orthogonal calibrated signals → uncertainty-aware Kelly → portfolio-level 
 tail/correlation risk. 
 
 That is the chain that turns “looks like a discount” into “verified discount with positive expected value,” and turns “looks like growth” into “confirmed 
 continuation with calibrated hit probability.” 
 
