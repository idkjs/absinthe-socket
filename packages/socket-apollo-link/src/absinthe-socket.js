import "phoenix";
import {Observable} from "@apollo/client";

const operationTypeRe = /^\s*(query|mutation|subscription|\{)/;

const getOperationTypeFromMatched = matched =>
  matched === "{" ? "query" : matched;

const getOperationType = operation => {
  const result = operation.match(operationTypeRe);

  if (!result) {
    throw new TypeError(`Invalid operation:\n${operation}`);
  }

  return getOperationTypeFromMatched(result[1]);
};

const requestToCompat = ({operation: query, variables}) =>
  variables ? {query, variables} : {query};

const locationsToString = locations =>
  locations.map(({column, line}) => `${line}:${column}`).join("; ");

const errorToString = ({message, locations}) =>
  message + (locations ? ` (${locationsToString(locations)})` : "");

const errorsToString = gqlErrors => gqlErrors.map(errorToString).join("\n");

const cancel = ({activeObservers, canceledObservers, ...rest}) => ({
  ...rest,
  isActive: false,
  activeObservers: [],
  canceledObservers: [...activeObservers, ...canceledObservers]
});

const notifyAll = (observers, event) => {
  const eventName = `on${event.name}`;
  const payload = event.payload;
  return observers.forEach(observer => {
    const event = observer[eventName];
    return event && event(payload);
  });
};

const notifyCanceled = (notifier, event) => {
  notifyAll(notifier.canceledObservers, event);
  return notifier;
};

const eventNames = {
  abort: "Abort",
  cancel: "Cancel",
  error: "Error",
  result: "Result",
  start: "Start"
};

const createStartEvent = payload => ({
  payload,
  name: eventNames.start
});

const createResultEvent = payload => ({
  payload,
  name: eventNames.result
});

const createErrorEvent = payload => ({
  payload,
  name: eventNames.error
});

const createCancelEvent = () => ({
  name: eventNames.cancel,
  payload: undefined
});

const createAbortEvent = payload => ({
  payload,
  name: eventNames.abort
});

const clearCanceled = notifier => ({...notifier, canceledObservers: []});

const flushCanceled = notifier =>
  notifier.canceledObservers.length > 0
    ? clearCanceled(notifyCanceled(notifier, createCancelEvent()))
    : notifier;

const refresh = notifier => notifiers =>
  notifiers.map(n => (n.request === notifier.request ? notifier : n));

const remove = notifier => notifiers =>
  notifiers.filter(n => n.request !== notifier.request);

const updateNotifiers = (absintheSocket, updater) => {
  absintheSocket.notifiers = updater(absintheSocket.notifiers);
  return absintheSocket;
};

const refreshNotifier = (absintheSocket, notifier) => {
  updateNotifiers(absintheSocket, refresh(notifier));
  return notifier;
};

const requestStatuses = {
  canceled: "canceled",
  canceling: "canceling",
  pending: "pending",
  sent: "sent",
  sending: "sending"
};

const notify = (notifier, event) => {
  notifyAll(
    [...notifier.activeObservers, ...notifier.canceledObservers],
    event
  );
  return notifier;
};

const abortNotifier = (absintheSocket, notifier, error) =>
  updateNotifiers(
    absintheSocket,
    remove(notify(notifier, createAbortEvent(error)))
  );

const notifyActive = (notifier, event) => {
  notifyAll(notifier.activeObservers, event);
  return notifier;
};

const notifyResultEvent = (notifier, result) =>
  notifyActive(notifier, createResultEvent(result));

const notifyStartEvent = notifier =>
  notifyActive(notifier, createStartEvent(notifier));

const reset = notifier =>
  flushCanceled({
    ...notifier,
    isActive: true,
    requestStatus: requestStatuses.pending,
    subscriptionId: undefined
  });

const handlePush = (push, handler) =>
  push
    .receive("ok", handler.onSucceed)
    .receive("error", handler.onError)
    .receive("timeout", handler.onTimeout);

const getPushHandler = (absintheSocket, request, notifierPushHandler) => {
  const wrapHandler = handler => (...args) => {
    const notifier = absintheSocket.notifiers.find(
      notifier => notifier.request === request
    );
    if (notifier) handler(absintheSocket, notifier, ...args);
  };

  return {
    onError: wrapHandler(notifierPushHandler.onError),
    onSucceed: wrapHandler(notifierPushHandler.onSucceed),
    onTimeout: wrapHandler(notifierPushHandler.onTimeout)
  };
};

const pushAbsintheEvent = (
  absintheSocket,
  request,
  notifierPushHandler,
  absintheEvent
) => {
  handlePush(
    absintheSocket.channel.push(absintheEvent.name, absintheEvent.payload),
    getPushHandler(absintheSocket, request, notifierPushHandler)
  );
  return absintheSocket;
};

const absintheEventNames = {
  doc: "doc",
  unsubscribe: "unsubscribe"
};

const createAbsintheUnsubscribeEvent = payload => ({
  payload,
  name: absintheEventNames.unsubscribe
});

const createAbsintheDocEvent = payload => ({
  payload,
  name: absintheEventNames.doc
});

const pushAbsintheDocEvent = (absintheSocket, {request}, notifierPushHandler) =>
  pushAbsintheEvent(
    absintheSocket,
    request,
    notifierPushHandler,
    createAbsintheDocEvent(requestToCompat(request))
  );

const setNotifierRequestStatusSending = (absintheSocket, notifier) =>
  refreshNotifier(absintheSocket, {
    ...notifier,
    requestStatus: requestStatuses.sending
  });

const createRequestError = message => {
  const error = new Error(`request: ${message}`);
  error.object = message;
  return error;
};

const onTimeout = (absintheSocket, notifier) =>
  notifyActive(notifier, createErrorEvent(createRequestError("timeout")));

const onError = (absintheSocket, notifier, errorMessage) =>
  abortNotifier(absintheSocket, notifier, createRequestError(errorMessage));

const getNotifierPushHandler = (onSucceed, onError) => ({
  onError,
  onSucceed,
  onTimeout
});

const pushRequestUsing = (absintheSocket, notifier, onSucceed) => {
  const onError = (absintheSocket, notifier, errorMessage) => {
    // handle graphql errors correctly, GraphQL shouldn't throw,
    // but passed as a payload...
    if (typeof errorMessage === "object" && errorMessage.errors) {
      onSucceed(absintheSocket, notifier, errorMessage);
    } else {
      onError(absintheSocket, notifier, errorMessage);
    }
  };

  pushAbsintheDocEvent(
    absintheSocket,
    setNotifierRequestStatusSending(absintheSocket, notifier),
    getNotifierPushHandler(onSucceed, onError)
  );
};

const onUnsubscribeSucceedCanceled = (absintheSocket, notifier) =>
  updateNotifiers(absintheSocket, remove(flushCanceled(notifier)));

const onUnsubscribeSucceedActive = (absintheSocket, notifier) =>
  subscribe(absintheSocket, refreshNotifier(absintheSocket, reset(notifier)));

const createUnsubscribeError = message => new Error(`unsubscribe: ${message}`);

const unsubscribeHandler = {
  onError: (absintheSocket, notifier, errorMessage) =>
    abortNotifier(
      absintheSocket,
      notifier,
      createUnsubscribeError(errorMessage)
    ),
  onTimeout: (absintheSocket, notifier) =>
    notifyCanceled(
      notifier,
      createErrorEvent(createUnsubscribeError("timeout"))
    ),
  onSucceed: (absintheSocket, notifier) => {
    if (notifier.isActive) {
      onUnsubscribeSucceedActive(absintheSocket, notifier);
    } else {
      onUnsubscribeSucceedCanceled(absintheSocket, notifier);
    }
  }
};

const pushAbsintheUnsubscribeEvent = (
  absintheSocket,
  {request, subscriptionId}
) =>
  pushAbsintheEvent(
    absintheSocket,
    request,
    unsubscribeHandler,
    createAbsintheUnsubscribeEvent({
      subscriptionId
    })
  );

const unsubscribe = (absintheSocket, notifier) =>
  pushAbsintheUnsubscribeEvent(
    absintheSocket,
    refreshNotifier(absintheSocket, {
      ...notifier,
      requestStatus: requestStatuses.canceling
    })
  );

const onSubscribeSucceed = (absintheSocket, notifier, {subscriptionId}) => {
  const subscribedNotifier = refreshNotifier(absintheSocket, {
    ...notifier,
    subscriptionId,
    requestStatus: requestStatuses.sent
  });

  if (subscribedNotifier.isActive) {
    notifyStartEvent(subscribedNotifier);
  } else {
    unsubscribe(absintheSocket, subscribedNotifier);
  }
};

const onSubscribe = (absintheSocket, notifier, response) => {
  if (response.errors) {
    onError(absintheSocket, notifier, errorsToString(response.errors));
  } else {
    onSubscribeSucceed(absintheSocket, notifier, response);
  }
};

const subscribe = (absintheSocket, notifier) =>
  pushRequestUsing(absintheSocket, notifier, onSubscribe);

const onDataMessage = (absintheSocket, {payload}) => {
  const notifier = absintheSocket.notifiers.find(
    n => n.subscriptionId === payload.subscriptionId
  );

  if (notifier) {
    notifyResultEvent(notifier, payload.result);
  }
};

const isDataMessage = message => message.event === "subscription:data";

const cancelQueryOrMutationSending = (absintheSocket, notifier) =>
  updateNotifiers(absintheSocket, refresh(flushCanceled(cancel(notifier))));

const cancelQueryOrMutationIfSending = (absintheSocket, notifier) =>
  notifier.requestStatus === requestStatuses.sending
    ? cancelQueryOrMutationSending(absintheSocket, notifier)
    : absintheSocket;

const cancelPending = (absintheSocket, notifier) =>
  updateNotifiers(absintheSocket, remove(flushCanceled(cancel(notifier))));

const cancelQueryOrMutation = (absintheSocket, notifier) =>
  notifier.requestStatus === requestStatuses.pending
    ? cancelPending(absintheSocket, notifier)
    : cancelQueryOrMutationIfSending(absintheSocket, notifier);

const unsubscribeIfNeeded = (absintheSocket, notifier) =>
  notifier.requestStatus === requestStatuses.sent
    ? unsubscribe(absintheSocket, notifier)
    : absintheSocket;

const cancelNonPendingSubscription = (absintheSocket, notifier) =>
  unsubscribeIfNeeded(
    absintheSocket,
    refreshNotifier(absintheSocket, cancel(notifier))
  );

const cancelSubscription = (absintheSocket, notifier) =>
  notifier.requestStatus === requestStatuses.pending
    ? cancelPending(absintheSocket, notifier)
    : cancelNonPendingSubscription(absintheSocket, notifier);

const cancelActive = (absintheSocket, notifier) =>
  notifier.operationType === "subscription"
    ? cancelSubscription(absintheSocket, notifier)
    : cancelQueryOrMutation(absintheSocket, notifier);

/**
 * Cancels a notifier sending a Cancel event to all its observers and
 * unsubscribing in case it holds a subscription request
 *
 * @example
 * import * as withAbsintheSocket from "@absinthe/socket";
 *
 * withAbsintheSocket.cancel(absintheSocket, notifier);
 */

const cancel$1 = (absintheSocket, notifier) =>
  notifier.isActive ? cancelActive(absintheSocket, notifier) : absintheSocket;

const setNotifierRequestStatusSent = (absintheSocket, notifier) =>
  refreshNotifier(absintheSocket, {
    ...notifier,
    requestStatus: requestStatuses.sent
  });

const onQueryOrMutationSucceed = (absintheSocket, notifier, response) =>
  updateNotifiers(
    absintheSocket,
    remove(
      notifyResultEvent(
        setNotifierRequestStatusSent(absintheSocket, notifier),
        response
      )
    )
  );

const pushQueryOrMutation = (absintheSocket, notifier) =>
  pushRequestUsing(
    absintheSocket,
    notifyStartEvent(notifier),
    onQueryOrMutationSucceed
  );

const pushRequest = (absintheSocket, notifier) => {
  if (notifier.operationType === "subscription") {
    subscribe(absintheSocket, notifier);
  } else {
    pushQueryOrMutation(absintheSocket, notifier);
  }
};

const createChannelJoinError = message => new Error(`channel join: ${message}`);

const notifyErrorToAllActive = (absintheSocket, errorMessage) =>
  absintheSocket.notifiers.forEach(notifier =>
    notifyActive(
      notifier,
      createErrorEvent(createChannelJoinError(errorMessage))
    )
  ); // join Push is reused and so the handler
// https://github.com/phoenixframework/phoenix/blob/master/assets/js/phoenix.js#L356

const createChannelJoinHandler = absintheSocket => ({
  onError: errorMessage => notifyErrorToAllActive(absintheSocket, errorMessage),
  onSucceed: () =>
    absintheSocket.notifiers.forEach(notifier =>
      pushRequest(absintheSocket, notifier)
    ),
  onTimeout: () => notifyErrorToAllActive(absintheSocket, "timeout")
});

const joinChannel = absintheSocket => {
  handlePush(
    absintheSocket.channel.join(),
    createChannelJoinHandler(absintheSocket)
  );
  absintheSocket.channelJoinCreated = true;
  return absintheSocket;
};

const createConnectionCloseError = () => new Error("connection: close");

const notifyConnectionCloseError = notifier =>
  notify(notifier, createErrorEvent(createConnectionCloseError()));

const notifierOnConnectionCloseCanceled = (absintheSocket, notifier) =>
  updateNotifiers(absintheSocket, remove(notifyConnectionCloseError(notifier)));

const notifierOnConnectionCloseActive = (absintheSocket, notifier) => {
  if (notifier.operationType === "mutation") {
    abortNotifier(absintheSocket, notifier, createConnectionCloseError());
  } else {
    refreshNotifier(
      absintheSocket,
      reset(notifyConnectionCloseError(notifier))
    );
  }
};

const notifierOnConnectionClose = absintheSocket => notifier => {
  if (notifier.isActive) {
    notifierOnConnectionCloseActive(absintheSocket, notifier);
  } else {
    notifierOnConnectionCloseCanceled(absintheSocket, notifier);
  }
};

const shouldJoinChannel = absintheSocket =>
  !absintheSocket.channelJoinCreated && absintheSocket.notifiers.length > 0;

const absintheChannelName = "__absinthe__:control";

/**
 * Creates an Absinthe Socket using the given Phoenix Socket instance
 *
 * @example
 * import * as withAbsintheSocket from "@absinthe/socket";
 * import {Socket as PhoenixSocket} from "phoenix";

 * const absintheSocket = withAbsintheSocket.create(
 *   new PhoenixSocket("ws://localhost:4000/socket")
 * );
 */

const create = phoenixSocket => {
  const absintheSocket = {
    phoenixSocket,
    channel: phoenixSocket.channel(absintheChannelName),
    channelJoinCreated: false,
    notifiers: []
  };

  phoenixSocket.onOpen(() => {
    if (shouldJoinChannel(absintheSocket)) joinChannel(absintheSocket);
  });

  phoenixSocket.onClose(() =>
    absintheSocket.notifiers.forEach(notifierOnConnectionClose(absintheSocket))
  );

  phoenixSocket.onMessage(message => {
    if (isDataMessage(message)) onDataMessage(absintheSocket, message);
  });

  return absintheSocket;
};

const observe = ({activeObservers, ...rest}, observer) => ({
  ...rest,
  activeObservers: [...activeObservers, observer],
  isActive: true
});

/**
 * Observes given notifier using the provided observer
 *
 * @example
 * import * as withAbsintheSocket from "@absinthe/socket"
 *
 * const logEvent = eventName => (...args) => console.log(eventName, ...args);
 *
 * const updatedNotifier = withAbsintheSocket.observe(absintheSocket, notifier, {
 *   onAbort: logEvent("abort"),
 *   onError: logEvent("error"),
 *   onStart: logEvent("open"),
 *   onResult: logEvent("result")
 * });
 */

const observe$1 = (absintheSocket, notifier, observer) =>
  refreshNotifier(absintheSocket, observe(notifier, observer));

const createUsing = (request, operationType) => ({
  operationType,
  request,
  activeObservers: [],
  canceledObservers: [],
  isActive: true,
  requestStatus: requestStatuses.pending,
  subscriptionId: undefined
});

const create$1 = request =>
  createUsing(request, getOperationType(request.operation));

const reactivate = notifier =>
  notifier.isActive ? notifier : {...notifier, isActive: true};

const connectOrJoinChannel = absintheSocket => {
  if (absintheSocket.phoenixSocket.isConnected()) {
    joinChannel(absintheSocket);
  } else {
    // socket ignores connect calls if a connection has already been created
    absintheSocket.phoenixSocket.connect();
  }
};

const sendNew = (absintheSocket, request) => {
  const notifier = create$1(request);
  updateNotifiers(absintheSocket, notifiers => [...notifiers, notifier]);

  if (absintheSocket.channelJoinCreated) {
    pushRequest(absintheSocket, notifier);
  } else {
    connectOrJoinChannel(absintheSocket);
  }

  return notifier;
};

const updateCanceledReactivate = (absintheSocket, notifier) =>
  refreshNotifier(absintheSocket, reactivate(notifier));

const updateCanceled = (absintheSocket, notifier) =>
  notifier.requestStatus === requestStatuses.sending
    ? updateCanceledReactivate(absintheSocket, flushCanceled(notifier))
    : updateCanceledReactivate(absintheSocket, notifier);

const updateIfCanceled = (absintheSocket, notifier) =>
  notifier.isActive ? notifier : updateCanceled(absintheSocket, notifier);

const getExistentIfAny = (absintheSocket, request) => {
  const notifier = absintheSocket.notifiers.find(n => n.request == request);

  return notifier && updateIfCanceled(absintheSocket, notifier);
};

/**
 * Sends given request and returns an object (notifier) to track its progress
 * (see observe function)
 *
 * @example
 * import * as withAbsintheSocket from "@absinthe/socket";
 *
 * const operation = `
 *   subscription userSubscription($userId: ID!) {
 *     user(userId: $userId) {
 *       id
 *       name
 *     }
 *   }
 * `;
 *
 * // This example uses a subscription, but the functionallity is the same for
 * // all operation types (queries, mutations and subscriptions)
 *
 * const notifier = withAbsintheSocket.send(absintheSocket, {
 *   operation,
 *   variables: {userId: 10}
 * });
 */

const send = (absintheSocket, request) =>
  getExistentIfAny(absintheSocket, request) || sendNew(absintheSocket, request);

const getUnsubscriber = (
  absintheSocket,
  {request},
  observer,
  unsubscribe
) => () => {
  const notifier = absintheSocket.notifiers.find(n => n.request === request);
  unsubscribe(absintheSocket, notifier, notifier ? observer : undefined);
};

const onResult = ({operationType}, observableObserver) => result => {
  observableObserver.next(result);

  if (operationType !== "subscription") {
    observableObserver.complete();
  }
};

const createObserver = (notifier, handlers, observableObserver) => ({
  ...handlers,
  onAbort: observableObserver.error.bind(observableObserver),
  onResult: onResult(notifier, observableObserver)
});

/**
 * Creates an Observable that will follow the given notifier
 *
 * @param {AbsintheSocket} absintheSocket
 * @param {Notifier<Result, Variables>} notifier
 * @param {Object} [options]
 * @param {function(error: Error): undefined} [options.onError]
 * @param {function(notifier: Notifier<Result, Variables>): undefined} [options.onStart]
 * @param {function(): undefined} [options.unsubscribe]
 *
 * @return {Observable}
 *
 * @example
 * import * as withAbsintheSocket from "@absinthe/socket";
 *
 * const unobserveOrCancelIfNeeded = (absintheSocket, notifier, observer) => {
 *   if (notifier && observer) {
 *     withAbsintheSocket.unobserveOrCancel(absintheSocket, notifier, observer);
 *   }
 * };
 *
 * const logEvent = eventName => (...args) => console.log(eventName, ...args);
 *
 * const observable = withAbsintheSocket.toObservable(absintheSocket, notifier, {
 *   onError: logEvent("error"),
 *   onStart: logEvent("open"),
 *   unsubscribe: unobserveOrCancelIfNeeded
 * });
 */

const toObservable = (
  absintheSocket,
  notifier,
  {unsubscribe, ...handlers} = {}
) =>
  new Observable(observableObserver => {
    const observer = createObserver(notifier, handlers, observableObserver);
    observe$1(absintheSocket, notifier, observer);
    return (
      unsubscribe &&
      getUnsubscriber(absintheSocket, notifier, observer, unsubscribe)
    );
  });

const removeObserver = (observers, observer) =>
  observers.filter(o => o !== observer);

const unobserve = ({activeObservers, ...rest}, observer) => ({
  ...rest,
  activeObservers: removeObserver(activeObservers, observer)
});

const ensureHasActiveObserver = (notifier, observer) => {
  if (notifier.activeObservers.includes(observer)) return notifier;
  throw new Error("Observer is not attached to notifier");
};

/**
 * Detaches observer from notifier
 *
 * @example
 * import * as withAbsintheSocket from "@absinthe/socket";
 *
 * withAbsintheSocket.unobserve(absintheSocket, notifier, observer);
 */

const unobserve$1 = (absintheSocket, notifier, observer) =>
  updateNotifiers(
    absintheSocket,
    refresh(unobserve(ensureHasActiveObserver(notifier, observer), observer))
  );

const doUnobserveOrCancel = (absintheSocket, notifier, observer) =>
  notifier.activeObservers.length === 1
    ? cancel$1(absintheSocket, notifier)
    : unobserve$1(absintheSocket, notifier, observer);

/**
 * Cancels notifier if there are no more observers apart from the one given, or
 * detaches given observer from notifier otherwise
 *
 * @example
 * import * as withAbsintheSocket from "@absinthe/socket";
 *
 * withAbsintheSocket.unobserve(absintheSocket, notifier, observer);
 */

const unobserveOrCancel = (absintheSocket, notifier, observer) =>
  notifier.isActive
    ? doUnobserveOrCancel(absintheSocket, notifier, observer)
    : absintheSocket;

export {
  cancel$1 as cancel,
  create,
  observe$1 as observe,
  send,
  toObservable,
  unobserve$1 as unobserve,
  unobserveOrCancel
};
