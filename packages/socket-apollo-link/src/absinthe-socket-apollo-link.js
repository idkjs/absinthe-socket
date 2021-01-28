// @flow

import {ApolloLink} from "@apollo/client";
import {print} from "graphql";
import {send, toObservable, unobserveOrCancel} from "./absinthe-socket";

const unobserveOrCancelIfNeeded = (absintheSocket, notifier, observer) => {
  if (notifier && observer) {
    unobserveOrCancel(absintheSocket, notifier, observer);
  }
};

const notifierToObservable = (absintheSocket, onError, onStart) => notifier =>
  toObservable(absintheSocket, notifier, {
    onError,
    onStart,
    unsubscribe: unobserveOrCancelIfNeeded
  });

const getRequest = ({query, variables}) => ({
  operation: print(query),
  variables
});

/**
 * Creates a terminating ApolloLink to request operations using given
 * AbsintheSocket instance
 */
export const createAbsintheSocketLink = (absintheSocket, onError?, onStart?) =>
  new ApolloLink(x =>
    notifierToObservable(
      absintheSocket,
      (...args) => {
        onError && onError(...args);
      },
      onStart
    )(send(absintheSocket, getRequest(x)))
  );
